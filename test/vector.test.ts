import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { Tile, Vector, VectorLayer, DEFAULT_EXTENT } from '../index.js';

test('VectorLayer: validation', () => {
    assert.throws(() => new VectorLayer(''), /name/);
    assert.throws(() => new VectorLayer('x', { extent: 0 }), RangeError);

    const layer = new VectorLayer('x');
    assert.equal(layer.extent, DEFAULT_EXTENT);
    assert.equal(layer.version, 2);

    assert.throws(() => layer.add({ type: 'LineString', geometry: [[[0, 0]]], properties: {} }), /positions/);
    assert.throws(() => layer.add({ type: 'Polygon', geometry: [[[0, 0], [1, 1]]], properties: {} }), /distinct/);
    assert.throws(() => layer.add({ type: 'Point', geometry: [[[0, 0]], [[1, 1]]], properties: {} }), /single part/);
    assert.throws(() => layer.add({ type: 'Point', geometry: [], properties: {} }), /geometry part/);
    assert.throws(() => layer.add({ type: 'Point', geometry: [[[0, NaN]]], properties: {} }), /position/);
    assert.throws(() => layer.add({ type: 'Point', id: -1, geometry: [[[0, 0]]], properties: {} }), RangeError);
    assert.throws(() => layer.add({ type: 'Circle' as never, geometry: [[[0, 0]]], properties: {} }), /geometry type/);
    assert.throws(() => layer.add({ type: 'Point', geometry: [[[0, 0]]], properties: { bad: null as never } }), /property/);
    assert.equal(layer.length, 0);
});

test('VectorLayer: add copies input and closes polygon rings', () => {
    const layer = new VectorLayer('x');
    const ring: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const props = { name: 'a' };

    layer.add({ type: 'Polygon', geometry: [ring], properties: props });
    ring.push([99, 99]);
    props.name = 'b';

    assert.deepEqual(layer.features[0].geometry, [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]);
    assert.equal(layer.features[0].properties.name, 'a');
    assert.throws(() => layer.feature(5), RangeError);
});

function sample(): Vector {
    const vector = new Vector();

    vector.layer('points').add({
        id: 7,
        type: 'Point',
        geometry: [[[100.4, 200.6]]],
        properties: { name: 'alpha', count: 3, ratio: 0.25, negative: -2, flag: true },
    });

    vector.layer('points').add({
        type: 'Point',
        geometry: [[[1, 1], [2, 2]]],
        properties: {},
    });

    vector.layer('lines', { extent: 256 }).add({
        type: 'LineString',
        geometry: [[[0, 0], [100, 100], [200, 50]], [[10, 10], [20, 10]]],
        properties: { ele: 1200 },
    });

    vector.layer('polys').add({
        id: 1,
        type: 'Polygon',
        geometry: [
            [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
            [[20, 20], [20, 40], [40, 40], [40, 20], [20, 20]],
        ],
        properties: { kind: 'box' },
    });

    return vector;
}

test('Vector: encode and decode round trip', () => {
    const encoded = sample().encode();
    assert.ok(encoded instanceof Uint8Array);
    assert.ok(encoded.length > 0);

    const decoded = Vector.decode(encoded);
    assert.deepEqual(Object.keys(decoded.layers).sort(), ['lines', 'points', 'polys']);

    const points = decoded.get('points')!;
    assert.equal(points.extent, 4096);
    assert.equal(points.version, 2);
    assert.equal(points.features[0].id, 7);
    assert.deepEqual(points.features[0].geometry, [[[100, 201]]]);
    assert.deepEqual(points.features[0].properties, { name: 'alpha', count: 3, ratio: 0.25, negative: -2, flag: true });
    assert.equal(points.features[1].id, undefined);
    assert.deepEqual(points.features[1].geometry, [[[1, 1], [2, 2]]]);

    const lines = decoded.get('lines')!;
    assert.equal(lines.extent, 256);
    assert.deepEqual(lines.features[0].geometry, [[[0, 0], [100, 100], [200, 50]], [[10, 10], [20, 10]]]);
    assert.deepEqual(lines.features[0].properties, { ele: 1200 });

    const polys = decoded.get('polys')!;
    assert.equal(polys.features[0].id, 1);
    assert.deepEqual(polys.features[0].geometry, sample().get('polys')!.features[0].geometry);

    const arrayBuffer = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(arrayBuffer).set(encoded);
    assert.deepEqual(Vector.decode(arrayBuffer).get('polys')!.features[0].geometry, polys.features[0].geometry);
});

test('Vector: output is readable by @mapbox/vector-tile directly', () => {
    const tile = new VectorTile(new PbfReader(sample().encode()));
    const layer = tile.layers.polys;
    assert.equal(layer.length, 1);

    const feature = layer.feature(0);
    assert.equal(feature.type, 3);
    assert.equal(feature.id, 1);
    assert.deepEqual({ ...feature.properties }, { kind: 'box' });
    assert.equal(feature.loadGeometry().length, 2);
});

test('Vector: empty tiles and layer reuse', () => {
    const vector = new Vector();
    assert.ok(vector.empty);
    assert.equal(vector.get('x'), undefined);

    const a = vector.layer('x', { extent: 512 });
    const b = vector.layer('x', { extent: 1024 });
    assert.equal(a, b);
    assert.equal(a.extent, 512);
    assert.ok(vector.empty);

    // Readers drop layers without features, so an empty layer does not survive a round trip
    const decoded = Vector.decode(vector.encode());
    assert.equal(decoded.get('x'), undefined);
    assert.ok(decoded.empty);
});

test('Vector: toGeoJSON unprojects into the tile', () => {
    const tile = new Tile(10, 212, 388);
    const [w, s, e, n] = tile.bounds();
    const fc = sample().toGeoJSON(tile);

    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, 4);

    const point = fc.features[0];
    assert.equal(point.id, 7);
    assert.equal(point.geometry.type, 'Point');
    const [lng, lat] = (point.geometry as GeoJSON.Point).coordinates;
    assert.ok(lng > w && lng < e && lat > s && lat < n);

    assert.equal(fc.features[1].geometry.type, 'MultiPoint');
    assert.equal(fc.features[2].geometry.type, 'MultiLineString');
    assert.equal(fc.features[3].geometry.type, 'Polygon');
    assert.deepEqual(fc.features[3].properties, { kind: 'box' });

    const corner = (fc.features[3].geometry as GeoJSON.Polygon).coordinates[0][0];
    assert.ok(Math.abs(corner[0] - w) < 1e-9);
    assert.ok(Math.abs(corner[1] - n) < 1e-9);

    const single = new Vector();
    single.layer('l').add({ type: 'LineString', geometry: [[[0, 0], [1, 1]]], properties: {} });
    assert.equal(single.toGeoJSON(tile).features[0].geometry.type, 'LineString');
});
