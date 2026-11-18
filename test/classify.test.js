'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const classify = require('../lib/classify');

classify._setEntries([
  { id: 11, errorMessage: 'Reservation is already cancelled.', friendlyMessage: 'This booking was cancelled by the airline.', supplierName: 'TravelportNdc', category: 'Bypass', description: 'd1' },
  { id: 12, errorMessage: 'NO VALID FARE FOR INPUT CRITERIA', friendlyMessage: 'The fare is no longer available.', supplierName: 'Galileo', category: 'Supplier', description: 'd2' },
  { id: 13, errorMessage: 'Specified HaltOnStatus Received - Processing Aborted', friendlyMessage: 'The airline stopped the reservation.', supplierName: 'Sabre', category: 'Bypass', description: 'd3' },
]);

test('matches error message for the same supplier, case and spacing insensitive', () => {
  const m = classify.match('Galileo', ['  no valid fare   for input criteria ']);
  assert.equal(m.id, 12); assert.equal(m.sameSupplier, true); assert.equal(m.matchedOn, 'error message'); assert.equal(m.category, 'Supplier');
});

test('matches the friendly message too (logs may hold the replaced text)', () => {
  const m = classify.match('Sabre', ['The airline stopped the reservation.']);
  assert.equal(m.id, 13); assert.equal(m.matchedOn, 'friendly message');
});

test('falls back to another supplier, flagged as not same supplier', () => {
  const m = classify.match('AirSMCairo', ['Reservation is already cancelled.']);
  assert.equal(m.id, 11); assert.equal(m.sameSupplier, false);
});

test('unknown text is unclassified; supplier name is case-insensitive', () => {
  assert.equal(classify.match('Galileo', ['Something new happened']), null);
  assert.equal(classify.match('travelportndc', ['RESERVATION IS ALREADY CANCELLED.']).id, 11);
});
