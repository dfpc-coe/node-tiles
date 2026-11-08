import test from 'node:test';
import assert from 'node:assert/strict';
import { Tile, Terrain, Hillshade, HILLSHADE_METHODS } from '../index.js';

const DEM = new Tile(12, 2048, 1024);

/**
 * A plane of `angle` degrees whose downslope faces compass `aspect`, sampled
 * so that the gradient is exact everywhere including the edges
 */
function facing(size: number, angle: number, aspect: number): Terrain {
    const rise = Math.tan(angle * Math.PI / 180);
    const theta = aspect * Math.PI / 180;
    // Elevation increases opposite the downslope direction; y grows southward
    const ux = -Math.sin(theta);
    const uy = Math.cos(theta);
    const stride = size + 2;
    const elevation = new Float32Array(stride * stride);
    const cell = DEM.resolution(size / 2, size);

    for (let py = -1; py <= size; py++) {
        for (let px = -1; px <= size; px++) {
            elevation[(py + 1) * stride + (px + 1)] = 1000 + (px * ux + py * uy) * cell * rise;
        }
    }

    return new Terrain(DEM, size, elevation, 1);
}

function flat(size: number): Terrain {
    return new Terrain(DEM, size, new Float32Array(size * size).fill(500));
}

function interior(values: Float32Array, size: number): number {
    return values[(size / 2) * size + size / 2];
}

test('Hillshade.parse: defaults, validation and serialize round trip', () => {
    assert.deepEqual(Hillshade.parse(), Hillshade.DEFAULTS);
    assert.deepEqual(Hillshade.parse({ token: 'abc' } as never), Hillshade.DEFAULTS);

    const opts = Hillshade.parse({
        azimuth: '90',
        altitude: '30.5',
        exaggeration: '2',
        method: 'igor',
        shadow: '#102030',
        highlight: 'FFFFFF80',
    });

    assert.deepEqual(opts, {
        azimuth: 90,
        altitude: 30.5,
        exaggeration: 2,
        method: 'igor',
        shadow: [16, 32, 48, 255],
        highlight: [255, 255, 255, 128],
    });

    const serialized = Hillshade.serialize(opts);
    assert.deepEqual(serialized, {
        azimuth: '90',
        altitude: '30.5',
        exaggeration: '2',
        method: 'igor',
        shadow: '102030',
        highlight: 'ffffff80',
    });
    assert.deepEqual(Hillshade.parse(serialized), opts);

    assert.throws(() => Hillshade.parse({ azimuth: '361' }), /0 <= azimuth <= 360/);
    assert.throws(() => Hillshade.parse({ azimuth: ['1', '2'] }), /single value/);
    assert.throws(() => Hillshade.parse({ altitude: '-1' }), /altitude/);
    assert.throws(() => Hillshade.parse({ altitude: '' }), /altitude/);
    assert.throws(() => Hillshade.parse({ altitude: 'abc' }), /altitude/);
    assert.throws(() => Hillshade.parse({ exaggeration: '0' }), /0 < exaggeration <= 100/);
    assert.throws(() => Hillshade.parse({ method: 'fancy' }), /expected one of standard, combined, igor, multidirectional/);
    assert.throws(() => Hillshade.parse({ method: ['igor'] }), /method/);
    assert.throws(() => Hillshade.parse({ shadow: 'red' }), /Invalid hillshade shadow: Invalid colour/);
    assert.throws(() => Hillshade.parse({ highlight: ['ffffff'] }), /single value/);
});

test('Hillshade.neutral: flat ground illumination per method', () => {
    assert.ok(Math.abs(Hillshade.neutral({ altitude: 45, method: 'standard' }) - Math.SQRT1_2) < 1e-9);
    assert.ok(Math.abs(Hillshade.neutral({ altitude: 90, method: 'multidirectional' }) - 1) < 1e-9);
    assert.equal(Hillshade.neutral({ altitude: 45, method: 'igor' }), 1);
    assert.equal(Hillshade.neutral({ altitude: 45, method: 'combined' }), 1);
});

test('Hillshade.shade: flat terrain lights evenly and planes respond to the light direction', () => {
    const size = 8;

    for (const method of HILLSHADE_METHODS) {
        const shade = Hillshade.shade(flat(size), { method, altitude: 30 });
        const expected = Hillshade.neutral({ altitude: 30, method });
        assert.ok(shade.every(v => Math.abs(v - expected) < 1e-6), `${method} flat = ${shade[0]}`);
    }

    // A 45 degree slope facing a 45 degree light from the north west is fully lit
    const lit = Hillshade.shade(facing(size, 45, 315));
    assert.ok(lit.every(v => Math.abs(v - 1) < 0.01), `lit ${lit[0]}`);

    // The same slope facing away is in full shadow
    const dark = Hillshade.shade(facing(size, 45, 135));
    assert.ok(dark.every(v => v < 0.01), `dark ${dark[0]}`);

    // Lights are compass azimuths: move the light east and the east-facing slope brightens
    const eastLight = Hillshade.shade(facing(size, 30, 90), { azimuth: 90 });
    const westLight = Hillshade.shade(facing(size, 30, 90), { azimuth: 270 });
    assert.ok(interior(eastLight, size) > interior(westLight, size));

    // Exaggeration steepens the terrain
    const gentle = Hillshade.shade(facing(size, 10, 315));
    const steep = Hillshade.shade(facing(size, 10, 315), { exaggeration: 3 });
    assert.ok(interior(steep, size) > interior(gentle, size));

    assert.ok(Hillshade.shade(facing(size, 80, 135), { altitude: 10 }).every(v => v === 0), 'clamped to zero');
});

test('Hillshade.shade: combined, igor and multidirectional methods', () => {
    const size = 8;
    const towards = interior(Hillshade.shade(facing(size, 30, 315), { method: 'combined' }), size);
    const away = interior(Hillshade.shade(facing(size, 30, 135), { method: 'combined' }), size);
    const steeper = interior(Hillshade.shade(facing(size, 60, 135), { method: 'combined' }), size);
    assert.ok(towards < 1 && towards > away, `combined lit ${towards} > shaded ${away}`);
    assert.ok(steeper < away, 'combined darkens with slope');
    assert.ok(steeper > 0);

    const igorLit = Hillshade.shade(facing(size, 30, 315), { method: 'igor' });
    const igorDark = Hillshade.shade(facing(size, 30, 135), { method: 'igor' });
    assert.ok(igorLit.every(v => Math.abs(v - 1) < 1e-6), 'igor never brightens a lit slope');
    assert.ok(Math.abs(interior(igorDark, size) - (1 - 30 / 90)) < 1e-3, `igor shadow ${interior(igorDark, size)}`);

    const multi = Hillshade.shade(facing(size, 30, 135), { method: 'multidirectional' });
    const single = Hillshade.shade(facing(size, 30, 135));
    assert.ok(interior(multi, size) > interior(single, size), 'multidirectional softens the shadow');
    assert.ok(Math.abs(interior(Hillshade.shade(facing(size, 30, 315), { method: 'multidirectional', azimuth: 90 }), size)
        - interior(Hillshade.shade(facing(size, 30, 315), { method: 'multidirectional' }), size)) < 1e-9, 'azimuth is ignored');
});

test('Hillshade.grey and colorize: rasters from illumination', () => {
    const size = 2;
    const shade = Float32Array.from([0, 0.25, 0.5, 1]);

    const grey = Hillshade.grey(shade, size);
    assert.equal(grey.channels, 1);
    assert.deepEqual(Array.from(grey.data), [0, 64, 128, 255]);
    assert.throws(() => Hillshade.grey(shade, 3), RangeError);

    const overlay = Hillshade.colorize(shade, size, { neutral: 0.5, shadow: [0, 0, 0, 200], highlight: [255, 255, 255, 100] });
    assert.deepEqual(overlay.get(0, 0), [0, 0, 0, 200]);
    assert.deepEqual(overlay.get(1, 0), [0, 0, 0, 100]);
    assert.deepEqual(overlay.get(0, 1), [0, 0, 0, 0]);
    assert.deepEqual(overlay.get(1, 1), [255, 255, 255, 100]);

    const defaults = Hillshade.colorize(Float32Array.from([Math.SQRT1_2, 1, 0, Math.SQRT1_2]), size);
    assert.deepEqual(defaults.get(0, 0), [0, 0, 0, 0]);
    assert.deepEqual(defaults.get(1, 0), [255, 255, 255, 255]);
    assert.deepEqual(defaults.get(0, 1), [0, 0, 0, 255]);

    assert.throws(() => Hillshade.colorize(shade, 3), RangeError);
    assert.throws(() => Hillshade.colorize(shade, size, { neutral: 2 }), RangeError);
});

test('Hillshade.render: flat ground is transparent, slopes pick a side', () => {
    const size = 8;
    assert.ok(Hillshade.render(flat(size)).data.every(v => v === 0));

    const lit = Hillshade.render(facing(size, 30, 315), { highlight: [255, 255, 0, 255] });
    assert.deepEqual(lit.get(4, 4).slice(0, 3), [255, 255, 0]);
    assert.ok(lit.get(4, 4)[3] > 0);

    const dark = Hillshade.render(facing(size, 30, 135), { shadow: [10, 20, 30, 255] });
    assert.deepEqual(dark.get(4, 4).slice(0, 3), [10, 20, 30]);

    const igor = Hillshade.render(facing(size, 30, 315), { method: 'igor' });
    assert.ok(igor.data.every(v => v === 0), 'igor leaves lit slopes untouched');
});
