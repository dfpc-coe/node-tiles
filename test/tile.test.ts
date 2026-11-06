import test from 'node:test';
import assert from 'node:assert/strict';
import { Tile, EARTH_CIRCUMFERENCE, MAX_LATITUDE } from '../index.js';

test('Tile: construction validates the address', () => {
    assert.throws(() => new Tile(-1, 0, 0), RangeError);
    assert.throws(() => new Tile(1.5, 0, 0), RangeError);
    assert.throws(() => new Tile(2, 4, 0), RangeError);
    assert.throws(() => new Tile(2, 0, -1), RangeError);
    assert.throws(() => new Tile(31, 0, 0), RangeError);

    const tile = new Tile(3, 5, 2);
    assert.equal(tile.key, '3/5/2');
    assert.equal(String(tile), '3/5/2');
    assert.equal(tile.scale, 8);
});

test('Tile: fromKey round trips and rejects garbage', () => {
    assert.ok(Tile.fromKey('12/2048/1024').equals(new Tile(12, 2048, 1024)));
    assert.throws(() => Tile.fromKey('12/2048'), /Invalid tile key/);
    assert.throws(() => Tile.fromKey('a/b/c'), /Invalid tile key/);
    assert.throws(() => Tile.fromKey('1/2/0'), RangeError);
});

test('Tile: bounds of the root and a known tile', () => {
    const [w, s, e, n] = new Tile(0, 0, 0).bounds();
    assert.equal(w, -180);
    assert.equal(e, 180);
    assert.ok(Math.abs(n - MAX_LATITUDE) < 1e-9);
    assert.ok(Math.abs(s + MAX_LATITUDE) < 1e-9);

    const denver = new Tile(10, 212, 388).bounds();
    assert.ok(Math.abs(denver[0] - -105.46875) < 1e-9);
    assert.ok(Math.abs(denver[2] - -105.1171875) < 1e-9);
    assert.ok(denver[1] > 39.6 && denver[1] < 39.7);
    assert.ok(denver[3] > 39.9 && denver[3] < 40.0);

    const [lng, lat] = new Tile(10, 212, 388).center();
    assert.ok(Math.abs(lng - -105.29296875) < 1e-9);
    assert.ok(lat > denver[1] && lat < denver[3]);
});

test('Tile: fromLngLat picks the covering tile and clamps the poles', () => {
    assert.ok(Tile.fromLngLat(-105.3, 39.8, 10).equals(new Tile(10, 212, 388)));
    assert.ok(Tile.fromLngLat(0, 0, 1).equals(new Tile(1, 1, 1)));
    assert.ok(Tile.fromLngLat(-180, 89, 2).equals(new Tile(2, 0, 0)));
    assert.ok(Tile.fromLngLat(180, -89, 2).equals(new Tile(2, 3, 3)));
});

test('Tile: hierarchy', () => {
    const tile = new Tile(4, 9, 6);
    assert.ok(tile.parent()!.equals(new Tile(3, 4, 3)));
    assert.ok(tile.ancestor(2).equals(new Tile(2, 2, 1)));
    assert.ok(tile.ancestor(0).equals(tile));
    assert.throws(() => tile.ancestor(5), RangeError);
    assert.equal(new Tile(0, 0, 0).parent(), null);

    const children = tile.children();
    assert.deepEqual(children.map(c => c.key), ['5/18/12', '5/19/12', '5/18/13', '5/19/13']);
    for (const child of children) assert.ok(tile.contains(child));
    assert.ok(tile.contains(tile));
    assert.ok(!tile.contains(new Tile(5, 20, 12)));
    assert.ok(!tile.contains(tile.parent()!));
});

test('Tile: neighbours wrap horizontally and stop at the grid edge', () => {
    const tile = new Tile(2, 0, 0);
    assert.ok(tile.neighbor(-1, 0)!.equals(new Tile(2, 3, 0)));
    assert.ok(tile.neighbor(1, 1)!.equals(new Tile(2, 1, 1)));
    assert.equal(tile.neighbor(0, -1), null);
    assert.equal(new Tile(2, 0, 3).neighbor(0, 1), null);
    assert.ok(tile.neighbor(4, 0)!.equals(tile));
    assert.throws(() => tile.neighbor(0.5, 0), RangeError);
});

test('Tile: pixel latitude and ground resolution', () => {
    const root = new Tile(0, 0, 0);
    assert.ok(Math.abs(root.resolution(127.5, 256) - 156543.03) < 0.01);
    assert.ok(Math.abs(root.latitude(127.5, 256)) < 1e-9);
    assert.ok(Math.abs(root.longitude(127.5, 256)) < 1e-9);

    const lat = new Tile(10, 212, 388).latitude(0, 256);
    const expected = EARTH_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) / (1024 * 256);
    assert.equal(new Tile(10, 212, 388).resolution(0, 256), expected);

    assert.ok(root.latitude(0, 256) > root.latitude(255, 256));
});

test('Tile: project and unproject round trip', () => {
    const tile = new Tile(10, 212, 388);
    const [px, py] = tile.project(-105.3, 39.8);
    assert.ok(px > 0 && px < 4096 && py > 0 && py < 4096);

    const [lng, lat] = tile.unproject(px, py);
    assert.ok(Math.abs(lng - -105.3) < 1e-9);
    assert.ok(Math.abs(lat - 39.8) < 1e-9);

    assert.deepEqual(tile.project(tile.bounds()[0], tile.bounds()[3]).map(v => Math.round(v * 1e6) / 1e6), [0, 0]);
    assert.deepEqual(tile.project(tile.bounds()[2], tile.bounds()[1], 256).map(v => Math.round(v * 1e6) / 1e6), [256, 256]);

    const outside = tile.project(-106, 39.8);
    assert.ok(outside[0] < 0);
});
