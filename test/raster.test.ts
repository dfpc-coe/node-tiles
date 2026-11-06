import test from 'node:test';
import assert from 'node:assert/strict';
import { Raster } from '../index.js';

test('Raster: construction validates dimensions and data length', () => {
    assert.throws(() => new Raster({ width: 0, height: 1, channels: 1 }), RangeError);
    assert.throws(() => new Raster({ width: 1, height: 1, channels: 5 }), RangeError);
    assert.throws(() => new Raster({ width: 2, height: 2, channels: 3, data: new Uint8Array(5) }), RangeError);

    const raster = Raster.alloc(2, 3);
    assert.equal(raster.channels, 4);
    assert.equal(raster.data.length, 24);
    assert.ok(!raster.square);
    assert.ok(Raster.alloc(4, 4, 1).square);
});

test('Raster: pixel access', () => {
    const raster = Raster.alloc(2, 2, 3);
    raster.set(1, 0, [1, 2, 3]);
    raster.set(0, 1, [4, 5, 6]);

    assert.deepEqual(raster.get(1, 0), [1, 2, 3]);
    assert.deepEqual(raster.get(0, 1), [4, 5, 6]);
    assert.deepEqual(raster.get(0, 0), [0, 0, 0]);
    assert.equal(raster.index(1, 1), 9);

    assert.throws(() => raster.get(2, 0), RangeError);
    assert.throws(() => raster.get(0, -1), RangeError);
    assert.throws(() => raster.set(0, 0, [1, 2]), RangeError);
});

test('Raster: toRGBA expands every channel layout', () => {
    const grey = new Raster({ width: 1, height: 1, channels: 1, data: Uint8Array.from([7]) });
    assert.deepEqual(grey.toRGBA().get(0, 0), [7, 7, 7, 255]);

    const greyAlpha = new Raster({ width: 1, height: 1, channels: 2, data: Uint8Array.from([7, 9]) });
    assert.deepEqual(greyAlpha.toRGBA().get(0, 0), [7, 7, 7, 9]);

    const rgb = new Raster({ width: 1, height: 1, channels: 3, data: Uint8Array.from([1, 2, 3]) });
    assert.deepEqual(rgb.toRGBA().get(0, 0), [1, 2, 3, 255]);

    const rgba = new Raster({ width: 1, height: 1, channels: 4, data: Uint8Array.from([1, 2, 3, 4]) });
    const copy = rgba.toRGBA();
    assert.deepEqual(copy.get(0, 0), [1, 2, 3, 4]);
    assert.notEqual(copy.data, rgba.data);
});

test('Raster: clone copies the buffer', () => {
    const raster = Raster.alloc(1, 1, 1);
    const clone = raster.clone();
    clone.set(0, 0, [5]);
    assert.deepEqual(raster.get(0, 0), [0]);
});

test('Raster: crop copies a window', () => {
    const raster = Raster.alloc(4, 4, 1);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) raster.set(x, y, [y * 4 + x]);

    const crop = raster.crop(1, 2, 2, 2);
    assert.equal(crop.width, 2);
    assert.equal(crop.height, 2);
    assert.deepEqual(Array.from(crop.data), [9, 10, 13, 14]);

    assert.throws(() => raster.crop(3, 3, 2, 2), RangeError);
    assert.throws(() => raster.crop(0, 0, 0, 1), RangeError);
});
