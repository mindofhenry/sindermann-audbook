import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, parseTime } from '../src/format.js';

test('formatTime shows minutes and seconds under an hour', () => {
  assert.equal(formatTime(125), '2:05');
});

test('formatTime shows hours once past an hour', () => {
  assert.equal(formatTime(3723), '1:02:03');
});

test('formatTime floors fractional seconds and clamps negatives to zero', () => {
  assert.equal(formatTime(59.9), '0:59');
  assert.equal(formatTime(-4), '0:00');
});

test('parseTime reads plain seconds', () => {
  assert.equal(parseTime('90'), 90);
});

test('parseTime reads clock notation', () => {
  assert.equal(parseTime('2:05'), 125);
  assert.equal(parseTime('1:02:03'), 3723);
});

test('parseTime reads unit notation', () => {
  assert.equal(parseTime('1h2m3s'), 3723);
  assert.equal(parseTime('5m'), 300);
  assert.equal(parseTime('45s'), 45);
});

test('parseTime returns null for input it cannot read', () => {
  assert.equal(parseTime('soon'), null);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime('1:99:00'), null);
});
