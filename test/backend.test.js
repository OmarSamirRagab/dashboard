'use strict';
process.env.OSD_USER = process.env.OSD_USER || 'test'; process.env.OSD_PASS = process.env.OSD_PASS || 'test'; // lib/core requires them; not used here
const test = require('node:test');
const assert = require('node:assert/strict');
const { needleOf } = require('../lib/backend');

test('needle is the longest fixed piece of the message', () => {
  assert.equal(needleOf('Your booking is being processed'), 'Your booking is being processed');
  assert.equal(needleOf('Supplier Error - FLIGHT IS BOARDING & ACCEPTED'), 'FLIGHT IS BOARDING & ACCEPTED');
  assert.equal(needleOf('PNR 123456 failed: "ABC" Wallet balance is less than Booking Amount'), 'Wallet balance is less than Booking Amount');
});

test('too short or numeric-only messages give no needle', () => {
  assert.equal(needleOf('Error 500'), null);
  assert.equal(needleOf(''), null);
  assert.equal(needleOf('1234567890'), null);
});
