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
