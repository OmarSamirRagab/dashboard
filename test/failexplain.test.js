'use strict';
process.env.OSD_USER = process.env.OSD_USER || 'test'; process.env.OSD_PASS = process.env.OSD_PASS || 'test'; // lib/core requires them; not used here
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractErrors } = require('../lib/failexplain');
const pick = (t) => extractErrors(t).map((e) => [e.kind, e.code, e.text]);

test('Sabre SOAP: error and warning messages with their codes', () => {
  const x = '<soapenv:Envelope><soapenv:Body><AirTicketRS><ApplicationResults status="NotProcessed"><Error type="BusinessLogic"><SystemSpecificResults>'
    + '<Message code="ERR.SP.PROVIDER_ERROR">NO VALID FARE FOR INPUT CRITERIA</Message></SystemSpecificResults></Error>'
    + '<Warning type="x"><SystemSpecificResults><Message code="WARN.1">EndTransaction warning</Message></SystemSpecificResults></Warning></ApplicationResults></AirTicketRS></soapenv:Body></soapenv:Envelope>';
  assert.deepEqual(pick(x), [['error', 'ERR.SP.PROVIDER_ERROR', 'NO VALID FARE FOR INPUT CRITERIA'], ['warning', 'WARN.1', 'EndTransaction warning']]);
});

test('SOAP fault: faultstring with faultcode as its code', () => {
  const x = '<SOAP:Envelope><SOAP:Body><SOAP:Fault><faultcode>Server.Business</faultcode><faultstring>PNR is updated by another user.</faultstring></SOAP:Fault></SOAP:Body></SOAP:Envelope>';
  assert.deepEqual(pick(x), [['error', 'Server.Business', 'PNR is updated by another user.']]);
});

test('NDC / JSON errors', () => {
  assert.deepEqual(pick(JSON.stringify({ Errors: { Error: [{ Code: '911', ShortText: 'Reservation is already cancelled.' }] } })), [['error', '911', 'Reservation is already cancelled.']]);
  assert.deepEqual(pick('{"status":"ERROR","errors":[{"code":"38","title":"OK ETICKET NO PRINTERS DEFINED"}]}'), [['error', '38', 'OK ETICKET NO PRINTERS DEFINED']]);
});

test('a successful response has no errors; plain Text outside an error is ignored', () => {
  assert.deepEqual(pick('<OrderViewRS><Response><Order OrderID="1"><Text>Hello</Text></Order></Response></OrderViewRS>'), []);
  assert.deepEqual(pick('{"status":"OK","message":"done"}'), []);
  assert.deepEqual(pick(''), []);
});
