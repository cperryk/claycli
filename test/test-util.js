const fetch = require('../lib/utils/fetch');

/**
* Assert exactly one fetch.send call has been made with the
* specified url, method, and body
* @param {string} method
* @param {string} url
* @param {Object|number} body
**/
function assertReq(method, url, body) {
  const matching = matchReq(method, url);

  body = typeof body === 'object' ? JSON.stringify(body) : body;
  if (matching.length > 1) {
    throw new Error(`expected only one ${method} request to ${url} but found ${matching.length}`);
  }
  if (matching.length === 0) {
    throw new Error(`expected a ${method} request to ${url} but found none`);
  }
  if (body) {
    expect(matching[0].args[1].body).to.eql(body);
  }
}

/**
* Return all the fetch.send calls that match the specified method, url, and (optionally) body.
* @param {string} method
* @param {string} url
* @param {Object} [body]
* @return {Object[]}
**/
function matchReq(method, url, body) {
  if (!fetch.send.getCalls) {
    throw new Error('You must stub fetch.send before using matchReq');
  }
  return fetch.send.getCalls()
    .filter(call =>
      call.args[0] === url &&
      call.args[1].method === method &&
      (body ? call.args[1].body === body : true));
}

/**
* Mock a request to the specified url with the specified method,
* resolving with the specified body or status code.
* @param {string} method
* @param {string} url
* @param {number|Object} body
**/
function mockReq(method, url, body) {
  if (!fetch.send.withArgs) {
    throw new Error('You must stub fetch.send before using mockReq');
  }
  fetch.send.withArgs(url, sinon.match({method})).returns(Promise.resolve({
    status: typeof body === 'number' ? body : 200,
    json: typeof body === 'object' ? () => body : undefined
  }));
}

/**
* Assert that the specified array has all and only the specified items,
* in any order
* @param {Array} results
* @param {Array} expected
*/
function assertItems(results, expected) {
  expect(results.length).to.equal(expected.length);
  expected.forEach(expectedResult => expect(results).to.include(expectedResult));
}

/**
 * Assert that the specified stream completes with the specified items.
 * @param {Stream} stream
 * @param {Array} expected
 */
function assertStream(stream, expected) {
  return stream.collect().toPromise(Promise).then((results) => {
    expect(results).to.eql(expected);
  });
}

module.exports.assertReq = assertReq;
module.exports.matchReq = matchReq;
module.exports.mockReq = mockReq;
module.exports.assertItems = assertItems;
module.exports.assertStream = assertStream;
