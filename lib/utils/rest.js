const bluebird = require('bluebird'),
  h = require('highland'),
  _ = require('lodash'),
  fetch = require('./fetch'),
  logger = require('./logger'),
  {createStream} = require('./stream-util'),
  CONTENT_TYPES = {
    json: 'application/json; charset=UTF-8',
    text: 'text/plain; charset=UTF-8'
  },
  DEFAULT_CONCURRENCY = 1; // note: argv.concurrency has a default of 10, so you should never be seeing requests go out at this value

fetch.send.Promise = bluebird;

function catchError(error) {
  return { statusText: error.message };
}

function checkStatus(url) {
  return (res) => {
    if (res.status && res.status >= 200 && res.status < 400) {
      return res;
    } else if (res.url && res.url !== url) {
      // login redirect!
      let error = new Error('Not Authorized');

      error.response = res;
      throw error;
    } else {
      // some other error
      let error = new Error(res.statusText);

      error.response = res;
      throw error;
    }
  };
}

function send(url, options) {
  // options.agent = false;

  return fetch.send(url, options)
    .catch(catchError)
    .then(checkStatus(url));
}

/**
 * get an array of urls
 * creates a stream with data from each url, or emits an error
 * @param  {Stream|array|string} urls array of urls or single url
 * @param {object} [options]
 * @param {number} [options.concurrency=1]
 * @param {object} [options.headers]
 * @param {string} [options.type='json']
 * @return {Stream}
 */
function get(urls, {concurrency = DEFAULT_CONCURRENCY, headers, type = 'json'} = {}) {
  return createStream(urls)
    .map((url) => {
      logger.debug(`GET ${url}`);
      return h(send(url, {
        method: 'GET',
        headers: headers
      })
      .then(res => res[type]())
      .catch((e) => {
        e.url = url; // capture the url every time we error
        e.method = 'GET';
        throw e;
      }));
    })
    .mergeWithLimit(concurrency);
}

/**
 * put an array of items
 * @param  {Stream|array|object} items with { url: data }
 * @param {object} [options]
 * @param {string} [options.key] authorization key of target resource
 * @param {number} [options.concurrency=1]
 * @param {object} [options.headers]
 * @param {string} [options.type='text'] "json" or "text"
 * @return {Stream}
 */
function put(items, {key = null, concurrency = DEFAULT_CONCURRENCY, headers, type = 'text'} = {}) {
  return createStream(items)
    .map((item) => {

      // each item should be { url, data: stringified }, e.g. if they're parsed by chunks.replacePrefixes
      const url = item.url,
        data = item.data;

      headers = Object.assign({
        'Content-Type': CONTENT_TYPES[type],
        Authorization: `Token ${key}`
      }, headers);
      logger.debug(`PUT ${url}`);
      return h(send(url, {
        method: 'PUT',
        body: typeof data === 'object' ? JSON.stringify(data) : data,
        headers
      })
      .then(() => ({
        // we don't care about the data returned from the put, but we do care it it worked or not
        status: 'success',
        url
      }))
      .catch((e) => {
        e.url = url;
        e.method = 'PUT';
        throw e;
      }));
    })
    .mergeWithLimit(concurrency);
}

/**
 * post an array of items
 * @param  {Stream|array|object} items with { url: data }
 * @param {object} [opts]
 * @param {string} key Authorization key
 * @param  {number} [concurrency]
 * @param {string} [type] content type
 * @return {Stream}
 */
function post(items, {key, concurrency = DEFAULT_CONCURRENCY, type = 'json'} = {}) {
  return createStream(items).map((item) => {
    // each item should be { url, data: stringified }, e.g. if they're parsed by chunks.replacePrefixes
    const url = item.url,
      data = item.data;

    logger.debug(`POST ${url}`);
    return h(send(url, {
      method: 'POST',
      body: typeof data === 'string' ? data : JSON.stringify(data),
      headers: {
        'Content-Type': CONTENT_TYPES[type],
        Authorization: `Token ${key}`
      }
    })
    .then(res => res.json())
    .catch((e) => {
      e.url = url;
      e.method = 'POST';
      throw e;
    }));
  }).mergeWithLimit(concurrency);
}

/**
* Error handler. If err represents 404 error, pass fnc(). Otherwise, push error.
* @param {function} fnc
* @returns {function}
*/
function pass404(fnc) {
  return (err, push) => _.get(err, 'response.status') === 404 ?
    push(null, fnc()) :
    push(err);
}

module.exports.pass404 = pass404;
module.exports.post = post;
module.exports.get = get;
module.exports.put = put;
