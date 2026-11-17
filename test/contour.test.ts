import test from 'node:test';
import assert from 'node:assert/strict';
import { Tile, Terrain, Contour, Vector } from '../index.js';
import type { Isoline, VectorPosition } from '../index.js';

const DEM = new Tile(12, 2048, 1024);

function terrain(size: number, pad: number, elevation: (px: number, py: number) => number, tile = DEM): Terrain {
    const stride = size + 2 * pad;
    const data = new Float32Array(stride * stride);

    for (let py = -pad; py < size + pad; py++) {
        for (let px = -pad; px < size + pad; px++) {
            data[(py + pad) * stride + (px + pad)] = elevation(px, py);
        }
    }

    return new Terrain(tile, size, data, pad);
}

function closed(line: VectorPosition[]): boolean {
    const first = line[0];
    const last = line.at(-1)!;
    return first[0] === last[0] && first[1] === last[1];
}

function surface(px: number, py: number): number {
    return 1000 + 7 * px + 3 * py + 40 * Math.sin(px / 3) * Math.cos(py / 4);
}

function crossings(isolines: Isoline[], x: number): Map<number, number[]> {
    const found = new Map<number, number[]>();

    for (const isoline of isolines) {
        const ys = isoline.lines.flat().filter(position => position[0] === x).map(position => position[1]).sort((a, b) => a - b);
        if (ys.length > 0) found.set(isoline.elevation, ys);
    }

    return found;
}

function at(isolines: Isoline[], elevation: number): Isoline {
    const found = isolines.find(isoline => isoline.elevation === elevation);
    assert.ok(found, `no isoline at ${elevation}`);
    return found;
}

test('Contour.parse: defaults, formats and limits', () => {
    assert.deepEqual(Contour.parse(), Contour.DEFAULTS);
    assert.notEqual(Contour.parse().intervals, Contour.DEFAULTS.intervals);

    assert.deepEqual(Contour.parse({ intervals: '40,200', multiplier: '3.28084', extent: '8192', buffer: '2' }), {
        intervals: [40, 200],
        multiplier: 3.28084,
        extent: 8192,
        buffer: 2,
    });
    assert.deepEqual(Contour.parse({ intervals: ['10', '50,100'] }).intervals, [10, 50, 100]);
    assert.deepEqual(Contour.parse({ intervals: '0.5,2.5' }).intervals, [0.5, 2.5]);

    assert.throws(() => Contour.parse({ intervals: '' }), /expected a number/);
    assert.throws(() => Contour.parse({ intervals: '10,abc' }), /expected a number/);
    assert.throws(() => Contour.parse({ intervals: '0' }), /Invalid contour interval/);
    assert.throws(() => Contour.parse({ intervals: '-10' }), /Invalid contour interval/);
    assert.throws(() => Contour.parse({ intervals: '40,100' }), /not a multiple of 40/);
    assert.throws(() => Contour.parse({ intervals: '1,2,4,8,16' }), /between 1 and 4 intervals/);
    assert.throws(() => Contour.parse({ multiplier: '0' }), /Invalid contour multiplier/);
    assert.throws(() => Contour.parse({ multiplier: ['1', '2'] }), /expected a single value/);
    assert.throws(() => Contour.parse({ extent: '100' }), /Invalid contour extent/);
    assert.throws(() => Contour.parse({ extent: '4096.5' }), /Invalid contour extent/);
    assert.throws(() => Contour.parse({ buffer: '-1' }), /Invalid contour buffer/);
    assert.throws(() => Contour.parse({ buffer: '17' }), /Invalid contour buffer/);
});

test('Contour.serialize: inverse of parse', () => {
    const opts = Contour.parse({ intervals: ['40', '200'], multiplier: '3.28084' });
    assert.deepEqual(Contour.serialize(opts), { intervals: '40,200', multiplier: '3.28084', extent: '4096', buffer: '1' });
    assert.deepEqual(Contour.parse(Contour.serialize(opts)), opts);
    assert.deepEqual(Contour.parse(Contour.serialize(Contour.DEFAULTS)), Contour.DEFAULTS);
});

test('Contour.intervals: nearest entry at or below the zoom', () => {
    const thresholds = { 11: [200, 1000], 13: [40, 200], 14: 20 };

    assert.deepEqual(Contour.intervals(10, thresholds), []);
    assert.deepEqual(Contour.intervals(11, thresholds), [200, 1000]);
    assert.deepEqual(Contour.intervals(12, thresholds), [200, 1000]);
    assert.deepEqual(Contour.intervals(13, thresholds), [40, 200]);
    assert.deepEqual(Contour.intervals(18, thresholds), [20]);
    assert.notEqual(Contour.intervals(13, thresholds), thresholds[13]);
});

test('Contour.isolines: straight lines across a plane, continued into the buffer', () => {
    // corner gx sits between pixels gx - 1 and gx, so it holds 995 + 10 * gx
    const isolines = Contour.isolines(terrain(16, 2, px => 1000 + 10 * px), { intervals: [20, 100] });

    assert.deepEqual(isolines.map(isoline => isoline.elevation), [1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140, 1160]);
    assert.deepEqual(isolines.map(isoline => isoline.level), [1, 0, 0, 0, 0, 1, 0, 0, 0]);

    for (const isoline of isolines) {
        assert.equal(isoline.lines.length, 1);
        const line = isoline.lines[0];
        const x = ((isoline.elevation - 995) / 10) * 256;

        assert.equal(line.length, 19);
        for (const position of line) assert.equal(position[0], x);
        assert.deepEqual(line.map(position => position[1]).sort((a, b) => a - b), Array.from({ length: 19 }, (_, i) => (i - 1) * 256));
    }

    // higher ground is on the left of the direction of travel
    const line = isolines[0].lines[0];
    assert.ok(line[0][1] < line.at(-1)![1]);
});

test('Contour.isolines: buffer and extent', () => {
    const plane = terrain(16, 2, px => 1000 + 10 * px);

    const tight = Contour.isolines(plane, { intervals: [20], buffer: 0, extent: 512 });
    assert.deepEqual(tight.map(isoline => isoline.elevation), [1000, 1020, 1040, 1060, 1080, 1100, 1120, 1140]);
    assert.deepEqual(tight[1].lines[0][0], [80, 0]);
    assert.deepEqual(tight[1].lines[0].at(-1), [80, 512]);
});

test('Contour.isolines: multiplier converts metres before contouring', () => {
    const isolines = Contour.isolines(terrain(16, 2, px => 300 + px), { intervals: [10], multiplier: Contour.FEET });

    const first = Math.ceil(298.5 * Contour.FEET / 10) * 10;
    assert.equal(isolines[0].elevation, first);
    assert.equal(isolines[1].elevation, first + 10);

    // 990 ft is 301.752 m, 2.252 corners past the corner holding 299.5 m
    const x = at(isolines, 990).lines[0][0][0];
    assert.equal(x, Math.round((990 / Contour.FEET - 299.5) * 256));
});

test('Contour.isolines: rings around a peak close on themselves', () => {
    const size = 64;
    const peak = terrain(size, 2, (px, py) => 2000 - 5 * Math.hypot(px + 0.5 - size / 2, py + 0.5 - size / 2));
    const isolines = Contour.isolines(peak, { intervals: [50] });

    const ring = at(isolines, 1900);
    assert.equal(ring.lines.length, 1);
    assert.ok(closed(ring.lines[0]));

    for (const [x, y] of ring.lines[0]) {
        const radius = Math.hypot(x - 2048, y - 2048) / (4096 / size);
        assert.ok(Math.abs(radius - 20) < 0.5, `radius ${radius}`);
    }

    // rings larger than the tile leave it as open lines ending on the buffer boundary
    const open = at(isolines, 1800);
    assert.equal(open.lines.length, 4);
    for (const line of open.lines) assert.ok(!closed(line));
});

test('Contour.isolines: lines meet across a tile edge', () => {
    const size = 16;
    const west = Contour.isolines(terrain(size, 2, surface), { intervals: [10] });
    const east = Contour.isolines(terrain(size, 2, (px, py) => surface(px + size, py), DEM.neighbor(1, 0)!), { intervals: [10] });

    const seam = crossings(west, 4096);
    assert.ok(seam.size > 5);
    assert.deepEqual(seam, crossings(east, 0));
    assert.deepEqual(crossings(west, 4096 + 256), crossings(east, 256));
});

test('Contour.isolines: rough terrain yields clean lines', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const noise = Array.from({ length: 36 * 36 }, () => random() * 300);

    const isolines = Contour.isolines(terrain(32, 2, (px, py) => noise[(py + 2) * 36 + (px + 2)]), { intervals: [25, 100] });
    const edges = new Set([-128, 4096 + 128]);
    let rings = 0;
    let open = 0;

    assert.ok(isolines.length >= 5);

    for (let i = 0; i < isolines.length; i++) {
        const isoline = isolines[i];

        if (i > 0) assert.ok(isoline.elevation > isolines[i - 1].elevation);
        assert.equal(isoline.level, isoline.elevation % 100 === 0 ? 1 : 0);
        assert.ok(isoline.lines.length > 0);

        for (const line of isoline.lines) {
            assert.ok(line.length >= 2);

            for (let p = 1; p < line.length; p++) {
                assert.ok(line[p][0] !== line[p - 1][0] || line[p][1] !== line[p - 1][1]);
            }

            if (closed(line)) {
                rings++;
                continue;
            }

            open++;
            for (const [x, y] of [line[0], line.at(-1)!]) {
                assert.ok(edges.has(x) || edges.has(y), `open line ends inside the tile at ${x},${y}`);
            }
        }
    }

    assert.ok(rings > 0);
    assert.ok(open > 0);
});

test('Contour.isolines: saddles keep both lines apart', () => {
    // corners hold 100 + 40 * u * v with the saddle point in the middle of the centre cell
    for (const sign of [1, -1]) {
        const saddle = terrain(5, 2, (px, py) => 100 + sign * 40 * (px - 2) * (py - 2));
        const isolines = Contour.isolines(saddle, { intervals: [100], buffer: 0, extent: 500 });

        const crossing = at(isolines, 100);
        assert.equal(crossing.lines.length, 2);

        for (const line of crossing.lines) {
            assert.ok(!closed(line));
            assert.ok(!line.some(([x, y]) => x === 250 && y === 250));
        }
    }
});

test('Contour.isolines: flat, unpadded and missing terrain', () => {
    assert.deepEqual(Contour.isolines(terrain(8, 2, () => 500)), []);
    assert.deepEqual(Contour.isolines(terrain(8, 2, () => 510)), []);

    const unpadded = Contour.isolines(terrain(8, 0, px => 5 * px), { intervals: [10] });
    assert.deepEqual(unpadded.map(isoline => isoline.elevation), [0, 10, 20, 30]);
    assert.ok(Object.is(unpadded[0].elevation, 0));

    const below = Contour.isolines(terrain(8, 2, px => -5 * px), { intervals: [10] });
    assert.deepEqual(below.map(isoline => isoline.elevation), [-40, -30, -20, -10, 0]);
    assert.ok(Object.is(below[4].elevation, 0));

    assert.deepEqual(Contour.isolines(terrain(8, 2, () => NaN)), []);

    const hole = Contour.isolines(terrain(16, 2, (px, py) => (px === 8 && py === 8 ? NaN : 1000 + 10 * px)), { intervals: [20] });
    assert.equal(at(hole, 1020).lines.length, 1);
    assert.equal(at(hole, 1080).lines.length, 2);
});

test('Contour.isolines: invalid options and runaway intervals', () => {
    const plane = terrain(8, 2, px => 1000 * px);

    assert.throws(() => Contour.isolines(plane, { intervals: [] }), /between 1 and 4 intervals/);
    assert.throws(() => Contour.isolines(plane, { intervals: [NaN] }), /Invalid contour interval/);
    assert.throws(() => Contour.isolines(plane, { intervals: [10, 25] }), /not a multiple/);
    assert.throws(() => Contour.isolines(plane, { multiplier: Infinity }), /Invalid contour multiplier/);
    assert.throws(() => Contour.isolines(plane, { extent: 0 }), /Invalid contour extent/);
    assert.throws(() => Contour.isolines(plane, { buffer: 0.5 }), /Invalid contour buffer/);
    assert.throws(() => Contour.isolines(plane, { intervals: [0.01] }), /too fine/);
});

test('Contour.render: one feature per elevation in a vector tile', () => {
    const plane = terrain(16, 2, px => 1000 + 10 * px);
    const vector = Contour.render(plane, { intervals: [20, 100] });

    const layer = vector.get('contours');
    assert.ok(layer);
    assert.equal(layer.extent, 4096);
    assert.equal(layer.length, 9);
    assert.deepEqual(layer.features[0].properties, { ele: 1000, level: 1 });
    assert.deepEqual(layer.features[1].properties, { ele: 1020, level: 0 });

    const decoded = Vector.decode(vector.encode()).get('contours');
    assert.ok(decoded);
    assert.equal(decoded.length, 9);
    assert.equal(decoded.features[0].type, 'LineString');
    assert.deepEqual(decoded.features[0].geometry, layer.features[0].geometry);
    assert.deepEqual(decoded.features[5].properties, { ele: 1100, level: 1 });

    const named = Contour.render(plane, { intervals: [20], extent: 512 }, { layer: 'isolines', elevationKey: 'elevation', levelKey: 'index' });
    assert.equal(named.get('contours'), undefined);
    assert.equal(named.get('isolines')?.extent, 512);
    assert.deepEqual(named.get('isolines')?.features[0].properties, { elevation: 1000, index: 0 });

    assert.ok(Contour.render(terrain(8, 2, () => 500)).empty);
    assert.deepEqual(Object.keys(Contour.render(terrain(8, 2, () => 500)).layers), []);
});
