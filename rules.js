// Exception knowledge base: turns a logged error into a plain explanation + suggested resolution.
// Built from the most frequent errors in ndc-core-backend-log (Oct–Nov 2026). Rules are tried in order; first match wins.
// impact: 'blocking' = stops the booking, 'related' = may affect it / needs a look, 'noise' = not booking-related.
'use strict';

const has = (re) => (x) => re.test(x.text);
const typeIs = (...t) => (x) => t.includes(x.type);
const frameHas = (re) => (x) => x.frames.some((f) => re.test(`${f.className}.${f.methodName}`));
const all = (...fs) => (x) => fs.every((f) => f(x));
const where = (x) => (x.top ? `${x.top.simpleClass}.${x.top.methodName}() line ${x.top.lineNumber}` : `${x.method || 'unknown method'}`);

const RULES = [
  // ---------- booking-blocking, known business cases ----------
  { id: 'flight-token-expired', impact: 'blocking',
    test: (x) => typeIs('FlightTokenNotFoundException', 'CConflictException')(x) || has(/selected flight is no longer available for booking/i)(x),
    title: 'Selected flight expired from cache',
    what: 'The flight option the agent selected could no longer be found in the flight cache (Redis) when booking or re-checking the fare.',
    cause: (x) => `The cached, encrypted flight option was missing${frameHas(/FlightCacheStorageService/)(x) ? ' (FlightCacheStorageService.getEncryptedCachedValue found nothing)' : ''}. Usually the agent took too long between search and booking and the cache entry expired, or the supplier said the offer is gone (409 Conflict).`,
    agent: ['Ask the agent to search again and book the new result without a long pause.'],
    dev: ['If this happens within minutes of the search, check Redis health and the flight-option TTL used by FlightCacheStorageService.', 'Check whether the supplier returned 409 in the timeline just before this error.'] },

  { id: 'duplicate-passenger', impact: 'blocking',
    test: has(/passengers already have a booking with the same details/i),
    title: 'Duplicate passenger booking blocked',
    what: 'Booking was refused because the same passenger(s) already have a booking with identical details (duplicate-booking protection, "pax hash").',
    cause: 'Either a real earlier booking exists for the same passenger/flight, or an earlier failed/cancelled attempt did not release its passenger hash (look for "failed to release pax hash for cancelled passengers" in the logs).',
    agent: ['Search existing bookings for this passenger and flight. If one is valid, use it instead of rebooking.', 'If the earlier booking is cancelled/failed, ask an admin to release it, then retry.'],
    dev: ['If the previous attempt was cancelled, verify that the pax hash was released; a stale hash means the release step failed.'] },

  { id: 'booking-in-progress', impact: 'blocking',
    test: has(/Your booking is being processed/i),
    title: 'Booking already in progress',
    what: 'A second booking request arrived while the first one for the same booking was still processing (double click / retry).',
    cause: 'Concurrent submit of the same booking; the lock rejected the second request.',
    agent: ['Do not retry immediately. Check the booking status first; the first request may still succeed.'],
    dev: ['If the first request never finishes, check for a long supplier call or a lock that is not released after a failure.'] },

  { id: 'hold-expired', impact: 'blocking',
    test: has(/Hold Expiration Date has passed|hold (has )?expired/i),
    title: 'Hold expired',
    what: 'The booking was cancelled because the hold expiration date (ticketing time limit) had passed.',
    cause: 'The agent tried to pay/ticket after the hold time limit.',
    agent: ['Make a new booking; the held one cannot be paid any more.'],
    dev: [] },

  { id: 'pnr-updated-elsewhere', impact: 'blocking',
    test: has(/PNR is updated by another user|simultaneous changes|SIMULTANEOUS CHANGES|reservation is being modified externally/i),
    title: 'PNR changed by someone else at the same time',
    what: 'Galileo refused the change because the PNR was modified by another user/process in between.',
    cause: 'Concurrent update of the same PNR (another agent, a queue process, the airline, or a double click).',
    agent: ['Retrieve the PNR again and repeat the action once; avoid double submits.'],
    dev: ['If it happens often for the same flow, retrieve the latest PNR version right before modifying it.'] },

  { id: 'offer-expired', impact: 'blocking',
    test: has(/offer has (been )?expired|offer is expired/i),
    title: 'Supplier offer expired',
    what: 'The NDC supplier offer the agent selected has expired.',
    cause: 'Too much time between search and booking; NDC offers are only valid for a short time.',
    agent: ['Search again and book the new offer without a long pause.'],
    dev: [] },

  { id: 'external-supplier-issue', impact: 'blocking',
    test: has(/external (supplier|technical) issue/i),
    title: 'Supplier-side error',
    what: 'The supplier returned an error that we show as a generic "external issue" message.',
    cause: 'Error on the supplier side; the exact supplier message is in the supplier response in the timeline.',
    agent: ['Retry once; if it repeats, contact the supplier with the booking time and PNR.'],
    dev: ['Check the supplier response in the timeline for the original error code.'] },

  { id: 'supplier-schema-validation', impact: 'blocking',
    test: has(/Message validation failed|cvc-complex-type|cvc-[a-z-]+\.\d/i),
    title: 'Request rejected by supplier (invalid XML)',
    what: 'The supplier rejected our request because it does not match their XML schema.',
    cause: 'Our request builder put an element in the wrong place or order (e.g. CustLoyalty before Email in Sabre passenger details). This is a code issue, not agent input.',
    agent: ['The agent cannot fix this; escalate to development with the booking ref.'],
    dev: ['Compare the request XML with the supplier schema named in the error and fix the element order/content in the request builder.'] },

  { id: 'issuance-verify-itinerary', impact: 'blocking',
    test: has(/ERROR AT ISSUANCE TIME|VERIFY ITINERARY/i),
    title: 'Ticket issuance failed – itinerary problem',
    what: 'The airline refused to issue the ticket because of a problem with the itinerary.',
    cause: 'Segment status, timing or routing in the PNR is not valid for ticketing (e.g. unconfirmed or changed segment).',
    agent: ['Retrieve the PNR and check segment statuses; rebook if a segment is not confirmed.'],
    dev: [] },

  { id: 'ndc-still-on-hold', impact: 'blocking',
    test: has(/still in the hold stage|No ticket has been issued/i),
    title: 'NDC booking still on hold – not ticketed',
    what: 'The NDC supplier reports the order is still on hold and no ticket was issued.',
    cause: 'Pay/ticket step did not complete at the supplier (payment to the airline not accepted, or ticketing still pending), so the order stayed in hold.',
    agent: ['Check the order in the supplier / admin: if still held, pay it again or ask support to issue; do not rebook while the hold is active.'],
    dev: ['Check the NDC pay-after-hold / ticketing response in the timeline for the supplier\'s reason.'] },

  { id: 'held-corporate-fare', impact: 'blocking',
    test: has(/does not allow amendments to held corporate fares/i),
    title: 'Held corporate fare cannot be amended',
    what: 'Galileo does not allow changes to a held corporate fare.',
    cause: 'The flow tried to amend a held booking priced with a corporate fare.',
    agent: ['Cancel the held booking and make a new one, as the message says.'],
    dev: [] },

  { id: 'reservation-cancelled', impact: 'blocking',
    test: has(/reservation (is|has) (already )?(been )?cancel+ed/i),
    title: 'Supplier reservation already cancelled',
    what: 'The supplier reports that the PNR/order is already cancelled.',
    cause: 'The hold expired (ticketing time limit passed) or the PNR was cancelled on the supplier side before payment/ticketing.',
    agent: ['Make a new booking; the old PNR cannot be ticketed.', 'If the agent was charged, raise a refund for the payment.'],
    dev: ['If holds are cancelled before their time limit, compare the hold time limit in the supplier response with when the payment arrived.'] },

  { id: 'sold-out', impact: 'blocking',
    test: has(/no longer available|not available anymore|sold out|Unable to AirPricing|NO VALID FARE FOR INPUT CRITERIA|AVAIL\/WL CLOSED|segments are not bookable|Unable to Sell Seg|FLIGHT NOT FOUND/i),
    title: 'Fare or class no longer available',
    what: 'The supplier could not price or sell the selected fare/class any more.',
    cause: (x) => `Seat availability changed between search and booking${x.supplier ? ` on ${x.supplier}` : ''} (class sold out, fare withdrawn).`,
    agent: ['Search again and choose another fare/class.'],
    dev: ['Only investigate if it repeats for fresh searches: compare the search response with the pricing request in the timeline.'] },

  { id: 'wallet-balance', impact: 'blocking',
    test: has(/wallet has no available balance|insufficient (balance|fund)/i),
    title: 'Agency wallet has no balance',
    what: 'Payment by wallet was refused because the agency balance is not enough.',
    cause: 'The agency\'s wallet/credit balance is lower than the booking amount.',
    agent: ['Agency tops up the wallet or pays by card, then books again.'],
    dev: [] },

  { id: 'bsp-not-allowed', impact: 'blocking',
    test: has(/not allowed to bsp ticketing/i),
    title: 'Agency not allowed to BSP ticket',
    what: 'The agency tried to issue a BSP ticket but is not authorised for BSP ticketing.',
    cause: 'Agency/branch configuration does not permit BSP ticketing for this booking.',
    agent: ['Check the agency\'s ticketing permissions in admin; use the allowed payment/ticketing mode.'],
    dev: [] },

  { id: 'galileo-ticketing', impact: 'blocking',
    test: has(/Host error during ticket issue|FILED FARE PARTIALLY TICKETED|NET TICKET DATA MAY NOT BE MODIFIED|FOP SELECTED NOT AUTHORIZED/i),
    title: 'Galileo ticket issue failed',
    what: 'The PNR was created but Galileo rejected the ticketing request.',
    cause: (x) => /NO RESPONSE FROM VENDOR/i.test(x.text) ? 'Galileo got no response from the airline (vendor) while issuing the ticket. The ticket may or may not have been issued.'
      : /INVALID NAME/i.test(x.text) ? 'The airline rejected a passenger name in the PNR.'
      : /FOP SELECTED NOT AUTHORIZED/i.test(x.text) ? 'The form of payment is not authorised for this carrier in the PCC.'
      : /PARTIALLY TICKETED/i.test(x.text) ? 'Part of the stored fare was already ticketed; Galileo refuses to ticket it again.'
      : /NET TICKET DATA/i.test(x.text) ? 'Net-fare ticket data in the PNR cannot be modified for this fare.'
      : 'Galileo host refused the ticket issue command.',
    agent: ['Do NOT rebook blindly: the PNR probably exists. Check the PNR in Galileo and ticket it manually if valid, or cancel it.'],
    dev: ['Compare the stored fare / form of payment in the ticketing request with the carrier agreement for this PCC.'] },

  { id: 'no-printer', impact: 'blocking',
    test: has(/NO PRINTERS DEFINED IN OFFICE PROFILE/i),
    title: 'Galileo PCC has no ticket printer',
    what: 'Galileo cannot issue the e-ticket because no ticket printer is linked to the office (PCC) profile.',
    cause: 'PCC configuration issue at Travelport, not a code problem.',
    agent: ['Ticket manually from another PCC if urgent.'],
    dev: ['DevOps/Support: ask the Travelport helpdesk to link a ticket printer to this PCC.'] },

  { id: 'triplink-card', impact: 'blocking',
    test: has(/TripLink createCard failed/i),
    title: 'TripLink virtual card creation failed',
    what: 'The virtual card used to pay the airline could not be created at TripLink.',
    cause: 'TripLink API error or limit; the airline payment could not be made.',
    agent: ['Retry later or book with another payment method.'],
    dev: ['Check the TripLink request/response in the timeline (externalService = TripLink).'] },

  { id: 'failed-before-supplier', impact: 'blocking',
    test: has(/booking failed before supplier call/i),
    title: 'Booking failed before reaching the supplier',
    what: 'The booking stopped inside our system before any supplier booking call; the booking row stays NOT_BOOKED.',
    cause: 'An earlier error in the same request (payment, validation, mapping). See the previous error in this session.',
    agent: ['The supplier was not called, so no PNR exists. The agent can retry after the cause is fixed.'],
    dev: ['Look at the error just before this one in the session; that is the real cause.'] },

  { id: 'booking-failed-generic', impact: 'blocking',
    test: has(/Booking Has been failed/i),
    title: 'Booking failed',
    what: 'The booking flow caught an exception and marked the booking as failed.',
    cause: (x) => x.exception ? `Underlying exception: ${x.exception}` : 'See the exception text and the previous events.',
    agent: ['Check the underlying exception above for the specific cause.'],
    dev: [] },

  // ---------- infrastructure ----------
  { id: 'db-connection', impact: 'blocking',
    test: has(/Cannot open connection|GenericJDBCException|CannotGetJdbcConnection|Communications link failure/i),
    title: 'Database connection unavailable',
    what: (x) => `The application on ${x.host || 'this server'} could not get a MySQL connection.`,
    cause: 'Connection pool exhausted (too many busy/leaked connections) or the database was unreachable/restarting at that moment.',
    agent: ['Retry after a few minutes.'],
    dev: (x) => [`DevOps: check MySQL availability and the connection pool on ${x.host || 'this host'} at ${x.firstLocal}.`, 'If it repeats, look for connection leaks (sessions not closed) in the failing code path.'] },

  { id: 'jdbc-batch', impact: 'related',
    test: has(/Could not execute JDBC batch update|DataException|ConstraintViolation|Data too long/i),
    title: 'Database write rejected',
    what: 'Saving data failed: the database rejected an insert/update.',
    cause: 'A value broke a column rule (too long, null in NOT NULL, duplicate key, bad type).',
    agent: ['Check whether the booking was saved; if not, retry.'],
    dev: (x) => [`Inspect the entity saved at ${where(x)}; compare field values with column sizes/constraints.`] },

  { id: 'dns', impact: 'blocking',
    test: typeIs('UnknownHostException'),
    title: 'Server could not resolve supplier host (DNS)',
    what: (x) => `${x.host || 'The server'} could not resolve ${x.msg || 'the supplier host name'}.`,
    cause: 'DNS or outbound network problem on that VM. Every call to this supplier from that server fails while it lasts.',
    agent: ['Retry; another server may handle the next request.'],
    dev: (x) => [`DevOps: check DNS resolution and outbound connectivity on ${x.host || 'the host'} (e.g. nslookup ${x.msg || '<host>'}).`] },

  { id: 'timeout', impact: 'related',
    test: has(/Read timed out|SocketTimeout|connect timed out|SSLException/i),
    title: 'Supplier call timed out',
    what: 'A call to an external system did not answer in time.',
    cause: (x) => `${x.supplier || 'The supplier'} was slow or unreachable.`,
    agent: ['Check the booking status with the supplier before retrying (the booking may exist on their side).'],
    dev: ['Check the supplier\'s response times around this time; review the timeout configured for this call.'] },

  { id: 'rate-limit', impact: 'related',
    test: (x) => typeIs('CTooManyRequestsException')(x) || has(/HTTP response code: 429|Too Many Requests/i)(x),
    title: 'Rate limited (too many requests)',
    what: 'The request was rejected because too many requests were sent in a short time.',
    cause: (x) => /nominatim/i.test(x.text) ? 'OpenStreetMap geocoding rate limit; unrelated to booking.' : 'Our rate limiter or the supplier throttled this agency/user.',
    agent: ['Wait a moment and retry.'],
    dev: ['If legitimate traffic is blocked, review the rate-limit settings for this endpoint.'] },

  { id: 'xml-parse', impact: 'related',
    test: has(/Premature end of file|Error while parsing XML|JDOMParseException|SAXParseException/i),
    title: 'Supplier returned an empty or invalid XML response',
    what: 'The response from a supplier could not be parsed as XML.',
    cause: 'Empty body, HTML error page, or truncated response from the supplier (often during supplier errors or timeouts).',
    agent: ['Retry; if the booking step failed, check status with the supplier first.'],
    dev: ['Open the matching "End external system call" response in the timeline to see what the supplier actually returned.'] },

  { id: 'json-convert', impact: 'related',
    test: has(/Failed to convert JSON to object/i),
    title: 'Unexpected JSON response',
    what: 'A JSON response could not be mapped to our objects.',
    cause: 'The supplier/API changed its format or returned an error body instead of the normal response.',
    agent: [],
    dev: ['Check the raw response of the preceding external call in the timeline against the DTO.'] },

  { id: 'airarabia-empty', impact: 'related',
    test: has(/AirArabia .*returned null|response is empty or null/i),
    title: 'Supplier returned an empty response',
    what: 'The supplier\'s availability/price response was empty, so no result could be built.',
    cause: 'Supplier error or no availability; the parser received nothing.',
    agent: ['Search again.'],
    dev: ['Check the supplier response in the timeline; empty responses during search are usually harmless.'] },

  { id: 'auth', impact: 'noise',
    test: typeIs('AuthenticationException'),
    title: 'Login failed (wrong credentials)',
    what: 'A user typed wrong credentials.', cause: 'User input.', agent: [], dev: [] },

  { id: 'broken-pipe', impact: 'noise',
    test: has(/Broken pipe|ClientAbortException|Connection reset by peer/i),
    title: 'Client disconnected',
    what: 'The browser/client closed the connection before the server finished sending the response.',
    cause: 'User navigated away, closed the tab, or the client timed out. Usually harmless.',
    agent: ['If it happened during booking, check the booking status: the server may have completed it.'], dev: [] },

  { id: 'search-hits-log', impact: 'noise',
    test: (x) => x.method === 'logFlightSearchHits' || frameHas(/logFlightSearchHits/)(x),
    title: 'Search statistics logging failed',
    what: 'Failed to record search-hit statistics.', cause: 'Logging side-task; does not affect searching or booking.', agent: [], dev: ['Low priority: fix the null in logFlightSearchHits.'] },

  // ---------- generic by exception type (code defects) ----------
  { id: 'email-after-ticket', impact: 'related', generic: true,
    test: all(typeIs('NullPointerException'), frameHas(/sendEmail|EmailTemplate|sendMail/i)),
    title: 'Error while sending the booking email',
    what: (x) => `A NullPointerException happened while preparing/sending the email at ${where(x)}.`,
    cause: (x) => frameHas(/doTicketing|processTicket/)(x)
      ? 'It happened inside the ticketing step, right after the supplier call. The booking/ticket itself may have SUCCEEDED and only the email/next step failed - or the booking response object was null because ticketing returned nothing.'
      : 'A value used to build the email was null.',
    agent: ['Before rebooking, check the PNR/ticket status with the supplier and in admin; the booking may exist.'],
    dev: (x) => [`Null-check the object used at ${where(x)} (see the highlighted line).`, 'Make email sending failure-tolerant so it cannot fail the booking.'] },

  { id: 'npe', impact: 'related', generic: true,
    test: typeIs('NullPointerException'),
    title: 'NullPointerException (code defect or missing data)',
    what: (x) => `A required value was null at ${where(x)}.`,
    cause: (x) => !x.frames.length
      ? 'No stack trace was logged. The JVM drops stack traces for exceptions that repeat very often at the same place (HotSpot "OmitStackTraceInFastThrow"), so this is usually the same NPE as other, traced events of this error. Look at those for the location.'
      : 'Missing data, usually a supplier response field that was absent, or an object that was not loaded. The highlighted line shows which expression was null.',
    agent: (x) => (x.phase === 'book' || x.phase === 'payment') ? ['Check the booking status before retrying; then retry once. If it repeats, escalate to development with this session id.'] : ['Retry; escalate if it repeats.'],
    dev: (x) => !x.frames.length
      ? ['DevOps: add -XX:-OmitStackTraceInFastThrow to the WildFly JVM options so every NPE keeps its stack trace.']
      : [`Find which reference is null on the highlighted line in ${x.top ? x.top.fileName : 'the code'} and why (check the preceding supplier response).`, 'Add a null check / clear error message instead of an NPE.'] },

  { id: 'number-format', impact: 'related', generic: true,
    test: typeIs('NumberFormatException'),
    title: 'Number parsing failed',
    what: (x) => `A text value could not be converted to a number at ${where(x)}${x.msg ? ` (value: ${x.msg})` : ''}.`,
    cause: 'An empty or non-numeric value (e.g. price, id, amount) came from input or a supplier response.',
    agent: ['Retry; escalate if it repeats.'],
    dev: (x) => [`Validate the value before parsing at ${where(x)}; log the offending value.`] },

  { id: 'index', impact: 'related', generic: true,
    test: typeIs('ArrayIndexOutOfBoundsException', 'IndexOutOfBoundsException', 'StringIndexOutOfBoundsException'),
    title: 'Expected list element missing',
    what: (x) => `Code read an element that does not exist at ${where(x)}${x.msg ? ` (${x.msg})` : ''}.`,
    cause: 'A list/array from the supplier response or input was shorter than expected (often empty: no segments, fares or passengers).',
    agent: ['Retry; escalate if it repeats.'],
    dev: (x) => [`Check the list size before indexing at ${where(x)}; inspect the supplier response that produced it.`] },

  { id: 'wrapper', impact: 'related', generic: true,
    test: has(/NestedServletException|InternalServerException|An unexpected error occurred/i),
    title: 'Unhandled error in a request',
    what: 'An exception escaped the controller and was returned as "An unexpected error occurred".',
    cause: 'The real cause is a different exception in the same request; see the other errors in this session.',
    agent: [], dev: ['Find the root exception logged just before this one.'] },
];

const FALLBACK = { id: 'unknown', impact: 'related', generic: true, title: 'Unrecognised error',
  what: (x) => `${x.type || 'Error'} at ${where(x)}.`,
  cause: 'No rule matches this error yet. Use the code location, the message and the preceding events.',
  agent: ['Escalate to development with the session id if it blocks the booking.'],
  dev: ['Read the highlighted code and the previous external call response.'] };

function explain(x) {
  const r = RULES.find((rule) => { try { return rule.test(x); } catch { return false; } }) || FALLBACK;
  const v = (f) => (typeof f === 'function' ? f(x) : f);
  // Errors during the booking/payment phase matter more even when the rule is generic.
  let impact = r.impact;
  if (impact === 'related' && x.blockingPhase) impact = 'blocking';
  return { rule: r.id, known: !r.generic && r !== FALLBACK, impact, title: r.title, what: v(r.what), cause: v(r.cause), agent: v(r.agent) || [], dev: v(r.dev) || [] };
}

module.exports = { explain };
