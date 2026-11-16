'use strict';
// node --test  (Node 18+, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const { explain } = require('../rules');

const ex = (text, extra = {}) => explain({ type: 'BookingException', msg: text, text, frames: [], phase: 'book', blockingPhase: true, ...extra });

test('known booking failure messages map to the right category', () => {
  const cases = [
    ['Reservation is already cancelled.', 'Supplier reservation already cancelled'],
    ['This reservation has already been cancelled.', 'Supplier reservation already cancelled'],
    ['One or more passengers already have a booking with the same details. Please contact Admin for booking.', 'Duplicate passenger booking blocked'],
    ['Your booking is being processed', 'Booking already in progress'],
    ['The booking is cancelled as the Hold Expiration Date has passed.', 'Hold expired'],
    ['PNR is updated by another user. Please try to retrieve the new PNR.', 'PNR changed by someone else at the same time'],
    ['The Provider reservation is being modified externally. Please Air Ticket later.', 'PNR changed by someone else at the same time'],
    ['The offer has been expired. Please try another offer.', 'Supplier offer expired'],
    ['One or more segments are not bookable.', 'Fare or class no longer available'],
    ['General air service Error. *0 AVAIL/WL CLOSED*', 'Fare or class no longer available'],
    ['OK ETICKET  NO PRINTERS DEFINED IN OFFICE PROFILE   PLEASE CALL HELP DESK', 'Galileo PCC has no ticket printer'],
    ['The wallet has no available balance.', 'Agency wallet has no balance'],
    ["Message validation failed. Errors: [cvc-complex-type.2.4.a: Invalid content was found starting with element 'CustLoyalty'", 'Request rejected by supplier (invalid XML)'],
    ['ERROR AT ISSUANCE TIME: VERIFY ITINERARY', 'Ticket issuance failed – itinerary problem'],
    ['Host error during ticket issue. FILED FARE PARTIALLY TICKETED', 'Galileo ticket issue failed'],
  ];
  for (const [msg, title] of cases) assert.equal(ex(msg).title, title, msg);
});

test('known patterns are marked known, unknown text falls back', () => {
  assert.equal(ex('Reservation is already cancelled.').known, true);
  const u = ex('something nobody has seen before');
  assert.equal(u.known, false);
});

test('NPE without stack trace explains the JVM omitted trace', () => {
  const r = explain({ type: 'NullPointerException', msg: '', text: 'NullPointerException', frames: [], phase: 'search' });
  assert.match(r.cause, /OmitStackTraceInFastThrow/);
  assert.ok(r.dev.some((d) => /OmitStackTraceInFastThrow/.test(d)));
});

test('errors in the payment/booking phase are ranked as blocking', () => {
  const r = explain({ type: 'NullPointerException', msg: '', text: 'NullPointerException', frames: [{ className: 'com.tt.X', methodName: 'm', lineNumber: 1, simpleClass: 'X', app: true }],
    top: { className: 'com.tt.X', methodName: 'm', lineNumber: 1, simpleClass: 'X' }, phase: 'payment', blockingPhase: true });
  assert.equal(r.impact, 'blocking');
});
