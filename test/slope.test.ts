import test from 'node:test';
import assert from 'node:assert/strict';
import { Tile, Terrain, Slope } from '../index.js';

const DEM = new Tile(12, 2048, 1024);

function plane(size: number, angle: number): Terrain {
    const elevation = new Float32Array(size * size);
    const rise = Math.tan(angle * Math.PI / 180);

    for (let py = 0; py < size; py++) {
        const cell = DEM.resolution(py, size);
        for (let px = 0; px < size; px++) elevation[py * size + px] = 1000 + px * cell * rise;
    }

    return new Terrain(DEM, size, elevation);
}

test('Slope.parse: defaults, formats and limits', () => {
    assert.deepEqual(Slope.parse(undefined), Slope.DEFAULT_CLASSES);
    assert.deepEqual(Slope.parse([]), Slope.DEFAULT_CLASSES);
    assert.notEqual(Slope.parse(undefined), Slope.DEFAULT_CLASSES);

    assert.deepEqual(Slope.parse('30:35:ff0000'), [{ lower: 30, upper: 35, color: [255, 0, 0, 255] }]);
    assert.deepEqual(Slope.parse(['27.5:30:#FFEB3BC8']), [{ lower: 27.5, upper: 30, color: [255, 235, 59, 200] }]);

    assert.throws(() => Slope.parse('30:35'), /expected lower:upper:hex_color/);
    assert.throws(() => Slope.parse('30:35:zzz'), /expected lower:upper:hex_color/);
    assert.throws(() => Slope.parse('35:30:ff0000'), /0 <= lower < upper <= 90/);
    assert.throws(() => Slope.parse('30:91:ff0000'), /0 <= lower < upper <= 90/);
    assert.throws(() => Slope.parse(new Array(Slope.MAX_CLASSES + 1).fill('30:35:ff0000')), /At most/);
});

test('Slope.serialize: inverse of parse with normalised hex', () => {
    const raw = ['27:30:#FFEB3BC8', '30:35:FF9800'];
    const classes = Slope.parse(raw);
    assert.deepEqual(Slope.serialize(classes), ['27:30:ffeb3bc8', '30:35:ff9800']);
    assert.deepEqual(Slope.parse(Slope.serialize(classes)), classes);
    assert.deepEqual(Slope.parse(Slope.serialize(Slope.DEFAULT_CLASSES)), Slope.DEFAULT_CLASSES);
});

test('Slope.legend: labels and CSS colours', () => {
    const legend = Slope.legend();
    assert.equal(legend.length, 5);
    assert.deepEqual(legend[0], { label: '27-30°', color: 'rgba(255, 235, 59, 0.78)' });
    assert.deepEqual(legend[4], { label: '50°+', color: 'rgba(33, 33, 33, 0.78)' });
    assert.deepEqual(Slope.legend(Slope.parse('0:10:ffffff')), [{ label: '0-10°', color: 'rgba(255, 255, 255, 1)' }]);
});

test('Slope.render: a 33 degree plane lands in the 30-35 class', () => {
    const size = 16;
    const raster = Slope.render(plane(size, 33));

    assert.equal(raster.width, size);
    assert.equal(raster.channels, 4);

    for (let py = 1; py < size - 1; py++) {
        for (let px = 1; px < size - 1; px++) {
            assert.deepEqual(raster.get(px, py), [255, 152, 0, 200]);
        }
    }
});

test('Slope.render: unclassified pixels are transparent and custom classes apply', () => {
    const size = 8;
    const flat = Slope.render(new Terrain(DEM, size, new Float32Array(size * size).fill(100)));
    assert.ok(flat.data.every(v => v === 0));

    const custom = Slope.render(plane(size, 33), Slope.parse('0:40:00ff00'));
    assert.deepEqual(custom.get(4, 4), [0, 255, 0, 255]);

    assert.throws(() => Slope.colorize(new Float32Array(3), 2), RangeError);
});
