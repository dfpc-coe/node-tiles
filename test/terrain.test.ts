import test from 'node:test';
import assert from 'node:assert/strict';
import { Tile, Raster, Terrain } from '../index.js';
import type { TerrainSource } from '../index.js';

const DEM = new Tile(12, 2048, 1024);

/** A plane rising eastward at `angle` degrees from 1000 m */
function plane(tile: Tile, size: number, angle: number): Terrain {
    const elevation = new Float32Array(size * size);
    const rise = Math.tan(angle * Math.PI / 180);

    for (let py = 0; py < size; py++) {
        const cell = tile.resolution(py, size);
        for (let px = 0; px < size; px++) {
            elevation[py * size + px] = 1000 + px * cell * rise;
        }
    }

    return new Terrain(tile, size, elevation);
}

test('Terrain: construction validates the grid', () => {
    assert.throws(() => new Terrain(DEM, 0, new Float32Array(0)), RangeError);
    assert.throws(() => new Terrain(DEM, 2, new Float32Array(3)), RangeError);
});

test('Terrain: terrarium and mapbox encodings round trip', () => {
    const size = 4;
    const elevation = Float32Array.from([
        -500, -32768, 0, 0.5,
        1000.25, 4321.125, 8848.5, 65535,
        -10000, 100000, 12.3, -0.1,
        1, 2, 3, 4,
    ]);
    const terrain = new Terrain(DEM, size, elevation);

    const terrarium = Terrain.decode(DEM, terrain.encode('terrarium'), 'terrarium');
    for (let i = 0; i < elevation.length; i++) {
        const clamped = Math.min(Math.max(elevation[i], -32768), 32768 - 1 / 256);
        assert.ok(Math.abs(terrarium.elevation[i] - clamped) <= 1 / 256 + 1e-6, `terrarium ${elevation[i]} -> ${terrarium.elevation[i]}`);
    }

    const mapbox = Terrain.decode(DEM, terrain.encode('mapbox'), 'mapbox');
    for (let i = 0; i < elevation.length; i++) {
        const clamped = Math.min(Math.max(elevation[i], -10000), (2 ** 24 - 1) * 0.1 - 10000);
        assert.ok(Math.abs(mapbox.elevation[i] - clamped) <= 0.05 + 1e-3, `mapbox ${elevation[i]} -> ${mapbox.elevation[i]}`);
    }
});

test('Terrain: decode accepts RGBA and rejects bad rasters', () => {
    const rgb = plane(DEM, 2, 10).encode('terrarium');
    const rgba = rgb.toRGBA();
    assert.deepEqual(Terrain.decode(DEM, rgba, 'terrarium').elevation, Terrain.decode(DEM, rgb, 'terrarium').elevation);

    assert.throws(() => Terrain.decode(DEM, Raster.alloc(2, 3, 3), 'terrarium'), /square/);
    assert.throws(() => Terrain.decode(DEM, Raster.alloc(2, 2, 1), 'terrarium'), /RGB/);
    assert.throws(() => Terrain.decode(DEM, rgb, 'bogus' as never), /encoding/);
    assert.throws(() => plane(DEM, 2, 10).encode('bogus' as never), /encoding/);
});

test('Terrain: at clamps to the edge and range spans the grid', () => {
    const terrain = new Terrain(DEM, 2, Float32Array.from([1, 2, 3, 4]));
    assert.equal(terrain.at(-5, -5), 1);
    assert.equal(terrain.at(9, 0), 2);
    assert.equal(terrain.at(0, 9), 3);
    assert.deepEqual(terrain.range(), [1, 4]);
});

test('Terrain: slope of a plane matches its angle away from the edges', () => {
    const size = 32;
    const slope = plane(DEM, size, 33).slope();

    for (let py = 1; py < size - 1; py++) {
        for (let px = 1; px < size - 1; px++) {
            assert.ok(Math.abs(slope[py * size + px] - 33) < 0.05, `pixel ${px},${py} = ${slope[py * size + px]}`);
        }
    }

    const flat = new Terrain(DEM, 4, new Float32Array(16).fill(500)).slope();
    assert.ok(flat.every(v => v === 0));
});

test('Terrain: overzoom resamples bilinearly and rejects non-descendants', () => {
    const size = 16;
    const elevation = new Float32Array(size * size);
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) elevation[py * size + px] = 1000 + px * 10 + py * 4;
    }
    const parent = new Terrain(DEM, size, elevation);

    const child = new Tile(14, DEM.x * 4 + 1, DEM.y * 4 + 2);
    const zoomed = parent.overzoom(child);

    assert.equal(zoomed.size, size);
    assert.ok(zoomed.tile.equals(child));

    // Child pixel centres sit at parent pixel coordinates (ox + (p + 0.5) / size) * size / 4 - 0.5
    for (let py = 0; py < size; py++) {
        const sy = Math.min((2 + (py + 0.5) / size) * size / 4 - 0.5, size - 1);
        for (let px = 0; px < size; px++) {
            const sx = Math.min((1 + (px + 0.5) / size) * size / 4 - 0.5, size - 1);
            const expected = 1000 + sx * 10 + sy * 4;
            assert.ok(Math.abs(zoomed.elevation[py * size + px] - expected) < 1e-3, `pixel ${px},${py}: ${zoomed.elevation[py * size + px]} vs ${expected}`);
        }
    }

    const edge = parent.overzoom(new Tile(14, DEM.x * 4 + 3, DEM.y * 4 + 3));
    assert.ok(Math.abs(edge.at(size - 1, size - 1) - parent.at(size - 1, size - 1)) < 1e-3);

    assert.throws(() => parent.overzoom(DEM), RangeError);
    assert.throws(() => parent.overzoom(new Tile(13, 0, 0)), RangeError);
});

function source(tiles: Record<string, Terrain>, requested: string[] = []): TerrainSource {
    return {
        encoding: 'terrarium',
        minzoom: 4,
        maxzoom: 12,
        tile: async (tile) => {
            requested.push(tile.key);
            const terrain = tiles[tile.key];
            return terrain ? terrain.encode('terrarium') : null;
        },
    };
}

test('Terrain: fetch returns the tile at its own zoom', async () => {
    const requested: string[] = [];
    const terrain = await Terrain.fetch(DEM, source({ [DEM.key]: plane(DEM, 8, 10) }, requested));
    assert.ok(terrain);
    assert.ok(terrain.tile.equals(DEM));
    assert.deepEqual(requested, [DEM.key]);
});

test('Terrain: fetch overzooms the nearest ancestor within the limit', async () => {
    const child = new Tile(14, DEM.x * 4 + 1, DEM.y * 4 + 2);
    const requested: string[] = [];
    const terrain = await Terrain.fetch(child, source({ [DEM.key]: plane(DEM, 8, 10) }, requested));

    assert.ok(terrain);
    assert.ok(terrain.tile.equals(child));
    assert.deepEqual(requested, [DEM.key]);

    const tooDeep = new Tile(17, DEM.x * 32, DEM.y * 32);
    assert.equal(await Terrain.fetch(tooDeep, source({ [DEM.key]: plane(DEM, 8, 10) })), null);
    assert.ok(await Terrain.fetch(tooDeep, source({ [DEM.key]: plane(DEM, 8, 10) }), { maxOverzoom: 5 }));
});

test('Terrain: fetch walks up through missing tiles and stops below minzoom', async () => {
    const requested: string[] = [];
    const grand = DEM.ancestor(2);
    const terrain = await Terrain.fetch(DEM, source({ [grand.key]: plane(grand, 8, 10) }, requested));

    assert.ok(terrain);
    assert.deepEqual(requested, [DEM.key, DEM.ancestor(1).key, grand.key]);

    const shallow: string[] = [];
    assert.equal(await Terrain.fetch(new Tile(5, 1, 1), source({}, shallow)), null);
    assert.deepEqual(shallow, ['5/1/1', '4/0/0']);

    await assert.rejects(Terrain.fetch(DEM, source({}), { maxOverzoom: -1 }), RangeError);
});

/** Sample a continuous surface defined over global pixel coordinates at the given zoom */
function surface(tile: Tile, size: number, fn: (gx: number, gy: number) => number): Terrain {
    const elevation = new Float32Array(size * size);

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            elevation[py * size + px] = fn(tile.x * size + px, tile.y * size + py);
        }
    }

    return new Terrain(tile, size, elevation);
}

/** Linear surface anchored on the DEM tile's origin at 8px so encoded values stay in range */
const LINEAR = (gx: number, gy: number) => 1000 + (gx - DEM.x * 8) * 10 + (gy - DEM.y * 8) * 4;

function ring(center: Tile, size: number, fn = LINEAR): Terrain[] {
    const neighbors: Terrain[] = [];

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const tile = center.neighbor(dx, dy);
            if (tile) neighbors.push(surface(tile, size, fn));
        }
    }

    return neighbors;
}

test('Terrain: padded grids validate, address negative pixels and exclude padding from range and encode', () => {
    assert.throws(() => new Terrain(DEM, 2, new Float32Array(4), -1), RangeError);
    assert.throws(() => new Terrain(DEM, 2, new Float32Array(4), 1), /padded by 1 needs 16/);

    const padded = new Terrain(DEM, 2, Float32Array.from([
        9, 9, 9, 9,
        9, 1, 2, 9,
        9, 3, 4, 9,
        9, 9, 9, 9,
    ]), 1);

    assert.equal(padded.stride, 4);
    assert.equal(padded.at(0, 0), 1);
    assert.equal(padded.at(1, 1), 4);
    assert.equal(padded.at(-1, 0), 9);
    assert.equal(padded.at(2, 2), 9);
    assert.equal(padded.at(-7, 7), 9);
    assert.deepEqual(padded.range(), [1, 4]);

    const encoded = Terrain.decode(DEM, padded.encode('terrarium'), 'terrarium');
    assert.equal(encoded.pad, 0);
    assert.deepEqual(Array.from(encoded.elevation), [1, 2, 3, 4]);
});

test('Terrain: mosaic removes edge artefacts from the gradient', () => {
    const size = 8;
    const center = surface(DEM, size, LINEAR);

    const clamped = center.gradient();
    assert.ok(Math.abs(clamped.dzdx[0] * DEM.resolution(0, size) - 10) > 1, 'unpadded edge pixel is wrong');

    const padded = center.mosaic(ring(DEM, size));
    assert.equal(padded.pad, 1);
    assert.equal(padded.size, size);
    assert.ok(padded.tile.equals(DEM));
    assert.equal(padded.at(-1, -1), LINEAR(DEM.x * size - 1, DEM.y * size - 1));
    assert.equal(padded.at(size, size), LINEAR(DEM.x * size + size, DEM.y * size + size));

    const { dzdx, dzdy } = padded.gradient();
    for (let py = 0; py < size; py++) {
        const cell = DEM.resolution(py, size);
        for (let px = 0; px < size; px++) {
            assert.ok(Math.abs(dzdx[py * size + px] * cell - 10) < 1e-3, `dzdx ${px},${py}`);
            assert.ok(Math.abs(dzdy[py * size + px] * cell - 4) < 1e-3, `dzdy ${px},${py}`);
        }
    }

    const wide = center.mosaic(ring(DEM, size), 3);
    assert.equal(wide.stride, size + 6);
    assert.equal(wide.at(-3, size + 2), LINEAR(DEM.x * size - 3, DEM.y * size + size + 2));
});

test('Terrain: mosaic clamps missing neighbours, wraps the antimeridian and rejects strangers', () => {
    const size = 4;
    const center = surface(DEM, size, LINEAR);

    const partial = center.mosaic([surface(DEM.neighbor(1, 0)!, size, LINEAR)]);
    assert.equal(partial.at(size, 0), LINEAR(DEM.x * size + size, DEM.y * size));
    assert.equal(partial.at(-1, 0), center.at(0, 0));
    assert.equal(partial.at(-1, -1), center.at(0, 0));

    const west = new Tile(12, 0, 1024);
    const east = new Tile(12, 4095, 1024);
    const wrapped = surface(west, size, LINEAR).mosaic([surface(east, size, LINEAR)]);
    assert.equal(wrapped.at(-1, 0), LINEAR(east.x * size + size - 1, east.y * size));

    assert.throws(() => center.mosaic([], 0), RangeError);
    assert.throws(() => center.mosaic([], size + 1), RangeError);
    assert.throws(() => center.mosaic([surface(new Tile(11, 1024, 512), size, LINEAR)]), /cannot neighbour/);
    assert.throws(() => center.mosaic([surface(DEM.neighbor(1, 0)!, size + 1, LINEAR)]), /cannot neighbour/);
    assert.throws(() => center.mosaic([surface(DEM.neighbor(2, 0)!, size, LINEAR)]), /not adjacent/);
    assert.throws(() => center.mosaic([center]), /not adjacent/);
});

test('Terrain: overzoom keeps padding and reads real neighbours for edge children', () => {
    const size = 8;
    const padded = surface(DEM, size, LINEAR).mosaic(ring(DEM, size));
    const child = new Tile(13, DEM.x * 2, DEM.y * 2);
    const zoomed = padded.overzoom(child);

    assert.equal(zoomed.pad, 1);
    assert.equal(zoomed.stride, size + 2);

    const { dzdx } = zoomed.gradient();
    for (let py = 0; py < size; py++) {
        const cell = child.resolution(py, size);
        for (let px = 0; px < size; px++) {
            assert.ok(Math.abs(dzdx[py * size + px] * cell - 5) < 1e-3, `dzdx ${px},${py} = ${dzdx[py * size + px] * cell}`);
        }
    }
});

test('Terrain: gradient and aspect follow the surface', () => {
    const size = 8;
    const east = plane(DEM, size, 30).mosaic(ring(DEM, size, (gx, gy) => plane(DEM, size, 30).at(gx - DEM.x * size, gy - DEM.y * size)));
    const { dzdx, dzdy } = east.gradient();
    assert.ok(Math.abs(dzdx[size * 4 + 4] - Math.tan(30 * Math.PI / 180)) < 1e-3);
    assert.ok(Math.abs(dzdy[size * 4 + 4]) < 1e-3);
    assert.ok(east.aspect().every(a => Math.abs(a - 270) < 0.5), 'rising eastward faces west');

    const south = surface(DEM, size, (_gx, gy) => gy * 10);
    const aspect = south.aspect();
    assert.ok(Math.abs(aspect[size * 4 + 4]) < 1e-6, 'rising southward faces north');

    const north = surface(DEM, size, (_gx, gy) => -gy * 10).aspect();
    assert.ok(Math.abs(north[size * 4 + 4] - 180) < 1e-6);

    const flat = new Terrain(DEM, 2, new Float32Array(4).fill(7)).aspect();
    assert.ok(flat.every(a => a === -1));
});

test('Terrain: fetch with pad reads only the neighbours the tile touches', async () => {
    const size = 8;
    const tiles: Record<string, Terrain> = { [DEM.key]: surface(DEM, size, LINEAR) };
    for (const neighbor of ring(DEM, size)) tiles[neighbor.tile.key] = neighbor;

    const all: string[] = [];
    const padded = await Terrain.fetch(DEM, source(tiles, all), { pad: 1 });
    assert.ok(padded);
    assert.equal(padded.pad, 1);
    assert.equal(all.length, 9);
    assert.equal(padded.at(-1, -1), LINEAR(DEM.x * size - 1, DEM.y * size - 1));

    const interior: string[] = [];
    const inner = await Terrain.fetch(new Tile(14, DEM.x * 4 + 1, DEM.y * 4 + 2), source(tiles, interior), { pad: 1 });
    assert.ok(inner);
    assert.deepEqual(interior, [DEM.key]);

    const corner: string[] = [];
    const nw = await Terrain.fetch(new Tile(14, DEM.x * 4, DEM.y * 4), source(tiles, corner), { pad: 1 });
    assert.ok(nw);
    assert.deepEqual(corner.slice(1).sort(), [DEM.neighbor(-1, -1)!.key, DEM.neighbor(0, -1)!.key, DEM.neighbor(-1, 0)!.key].sort());

    const { dzdx } = nw.gradient();
    assert.ok(Math.abs(dzdx[0] * nw.tile.resolution(0, size) - 2.5) < 1e-3);

    const sparse: string[] = [];
    const alone = await Terrain.fetch(DEM, source({ [DEM.key]: tiles[DEM.key] }, sparse), { pad: 1 });
    assert.ok(alone);
    assert.equal(alone.at(-1, 0), alone.at(0, 0));

    const top = new Tile(12, 2048, 0);
    const polar: string[] = [];
    assert.ok(await Terrain.fetch(top, source({ [top.key]: surface(top, size, LINEAR) }, polar), { pad: 1 }));
    assert.equal(polar.length, 6);

    await assert.rejects(Terrain.fetch(DEM, source({}), { pad: -1 }), RangeError);
    await assert.rejects(Terrain.fetch(DEM, source({}), { pad: 1.5 }), RangeError);
});
