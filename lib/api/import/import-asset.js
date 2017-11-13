const rest = require('../../utils/rest'),
  _ = require('lodash'),
  h = require('highland'),
  {createStream} = require('../../utils/stream-util');

/**
* Commit the data in a {data, url} Clay assets via a PUT request,
* unless clayAsset.skip is true.
* @param {Object|Object[]|Stream} [clayAsset]
* @param {string} [options.key]
* @param {number} [options.concurrency]
* @param {Object} [options.headers]
* @param {function} [options.touchup] Stream-returning fnc to modify assets before PUTs
* @return {Stream}
*/
function importAssets(clayAsset, {key, concurrency, headers, touchup} = {}) {
  return createStream(clayAsset)
    .flatMap(touchup ? touchup : asset => h.of(asset))
    .flatMap((clayAsset) => {
      return clayAsset.skip ?
        h.of({url: clayAsset.url, status: 'skipped'}) :
        rest.put(clayAsset, {
          key,
          concurrency,
          headers,
          type: _.includes(clayAsset.url, '/uris') ? 'text' : 'json'
        });
    });
}

module.exports = importAssets;
