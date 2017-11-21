const _ = require('lodash'),
  h = require('highland'),
  clayUtils = require('clay-utils'),
  b64 = require('base-64'),
  urlUtil = require('../utils/urls'),
  rest = require('../utils/rest'),
  config = require('../utils/config'),
  {createStream} = require('../utils/stream-util'),
  refProp = '_ref';

/**
 * expand references in component lists
 * @param  {array} val
 * @return {array}
 */
function expandListReferences(val) {
  if (_.has(_.head(val), refProp)) {
    // component list! return the references
    return _.map(val, (item) => item[refProp]);
  } else {
    return [];
  }
}

/**
 * expand references in component properties
 * @param  {object} val
 * @return {array}
 */
function expandPropReferences(val) {
  if (_.has(val, refProp)) {
    return [val[refProp]];
  } else {
    return [];
  }
}

/**
 * get list of instances in a component
 * @param  {string} prefix of site
 * @param  {string} name of component
 * @param {object} [options]
 * @param {number} [concurrency]
 * @param {object} [headers]
 * @param {boolean} [onlyPublished]
 * @return {Stream}
 */
function getComponentInstances(prefix, name, {concurrency, headers, onlyPublished} = {}) {
  return rest.get(`${prefix}/components/${name}/instances${onlyPublished ? '/@published' : ''}`, {
    concurrency,
    headers
  });
}

/**
 * list all references in a component
 * @param  {object} data
 * @return {array} of uris
 */
function listComponentReferences(data) {
  return _.reduce(data, (result, val) => {
    if (_.isArray(val)) {
      return result.concat(expandListReferences(val));
    } else if (_.isObject(val)) {
      return result.concat(expandPropReferences(val));
    } else {
      return result;
    }
  }, []);
}

/**
 * push rest errors into the stream
 * @param  {Error} err
 * @param  {function} push
 */
function pushRestError(err, push) {
  push(null, { status: 'error', url: err.url, message: err.message }); // every url that errors out should be captured
}

/**
 * check a if a single component uri exists
 * @param {number} concurrency
 * @param {string} prefix
 * @param  {string|object} url or error object
 * @return {Stream} of { status: 'success or error', url (if error) }
 */
function checkReference(concurrency, prefix, url) {
  if (!_.isString(url)) {
    // error / success object, pass it on
    return h([url]);
  }

  // make sure url is using the correct prefix
  url = urlUtil.uriToUrl(prefix, url);

  // todo: when HEAD requests are supported in amphora, simply call rest.check(url)
  return rest.get(url, {concurrency})
    .map(() => ({ status: 'success' }))
    // we don't care about data, but we want the resulting stream's length
    // to be the number of urls we've checked
    .errors(pushRestError);
};

/**
 * check if an array of component references exist,
 * recursively checking references in each component
 * @param {number} concurrency
 * @param {string} prefix
 * @param  {array|string|object} uris, single uri, or error object
 * @return {Stream} of { status: 'success or error', url (if error) }
 */
function recursivelyCheckReference(concurrency, prefix, uris) {
  let urls;

  if (_.isArray(uris) && uris.length) {
    urls = _.map(uris, (uri) => urlUtil.uriToUrl(prefix, uri));
  } else if (_.isString(uris)) {
    urls = [urlUtil.uriToUrl(prefix, uris)];
  } else {
    // error / success object, pass it on
    return h([uris]);
  }

  return rest.get(urls, {concurrency})
    .flatMap((data) => {
      const childUris = listComponentReferences(data); // adding prefix when passed in recursively, so you don't need to do that here

      if (childUris.length) {
        return h([h.of({ status: 'success' }), recursivelyCheckReference(concurrency, prefix, childUris)]).merge();
      } else {
        return h.of({ status: 'success' });
      }
    }).errors(pushRestError);
}

/**
 * check all references in a component,
 * and (if recursive) all the children of that component
 * @param  {string} url
 * @param {string} prefix
 * @param {boolean} [isRecursive]
 * @param {number} concurrency
 * @return {Stream} of { status: 'success or error', url (if error) }
 */
function checkComponent(url, prefix, isRecursive, concurrency) {
  const stream = rest.get(url, {concurrency})
    .flatMap((data) => {
      const childUris = listComponentReferences(data);

      return h([h.of({ status: 'success' }), h(childUris)]).merge();
    }).errors(pushRestError);

  if (isRecursive) {
    return stream.flatMap(recursivelyCheckReference.bind(null, concurrency, prefix));
  } else {
    return stream.flatMap(checkReference.bind(null, concurrency, prefix));
  }
}

/**
 * check all references in a page,
 * and (if recursive) all the children of the components in the page
 * @param  {string} url
 * @param {string} prefix
 * @param {boolean} [isRecursive]
 * @param {number} concurrency
 * @return {Stream} of { status: 'success or error', url (if error) }
 */
function checkPage(url, prefix, isRecursive, concurrency) {
  const stream = rest.get(url, {concurrency})
    .flatMap((data) => {
      const layoutUri = data.layout,
        otherComponentUris = _.reduce(data, (uris, area) => {
          if (_.isArray(area)) {
            return uris.concat(area);
          } else {
            return uris;
          }
        }, []);

      return h([h.of({ status: 'success' }), h([layoutUri].concat(otherComponentUris))]).merge();
    }).errors(pushRestError);

  if (isRecursive) {
    return stream.flatMap(recursivelyCheckReference.bind(null, concurrency, prefix));
  } else {
    return stream.flatMap(checkReference.bind(null, concurrency, prefix));
  }
}

/**
 * check if a public url exists, then check the references in its page
 * and (if recursive) all the children of the components in the page
 * @param  {string} url
 * @param {string} prefix
 * @param {boolean} [isRecursive]
 * @param {number} concurrency
 * @return {Stream} of { status: 'success or error', url (if error) }
 */
function checkPublicUrl(url, prefix, isRecursive, concurrency) {
  let publicUrl;

  if (!prefix) {
    return h.fromError(new Error('Site prefix is required to check public urls!'));
  }

  publicUrl = `${prefix}/uris/${b64.encode(urlUtil.urlToUri(url))}`;
  return rest.get(publicUrl, {concurrency})
    .flatMap((pageUri) => {
      const pageUrl = urlUtil.uriToUrl(prefix, pageUri);

      return checkPage(pageUrl, prefix, isRecursive, concurrency);
    }).errors(pushRestError);
}

/**
 * check all references in a component,
 * and (if recursive) all the children of that component
 * @param  {string} uri
 * @param {boolean} [isRecursive]
 * @param {string} [prefix]
 * @param {number} concurrency
 * @return {Stream} of { status: 'success or error', url (if error) }
 */
function checkAllReferences(uri, isRecursive, prefix, concurrency) {
  const url = config.normalizeSite(uri);

  // uris use a passed-in prefix (so it can send back a nice error if they don't specify it),
  // whereas components and pages grab the prefix from the root url we're checking
  if (clayUtils.isComponent(url)) {
    return checkComponent(url, urlUtil.getUrlPrefix(url).prefix, isRecursive, concurrency);
  } else if (clayUtils.isPage(url)) {
    return checkPage(url, urlUtil.getUrlPrefix(url).prefix, isRecursive, concurrency);
  } else {
    return checkPublicUrl(url, prefix, isRecursive, concurrency);
  }
}

/**
 * get composed component data
 * @param  {string} url
 * @param  {number} concurrency
 * @return {[type]}             [description]
 */
function getDeepComponent(url, concurrency, headers) {
  return rest.get(`${url}.json`, {concurrency, headers})
    .map((data) => ({ url, data }));
}

/**
 * Given a stream of URLs, array of URLs, or single URL to Clay
 * components, pages, or lists, return a stream of Clay assets
 * of the form {url, data, isLayout}. Component URLs stream
 * composed components. List URLs stream full list arrays. Page URLs
 * stream page objects and composed page-level components.
 * @param {Stream|string[]|string} urls stream or array of of URLs, or single URL
 * @param  {number} [concurrency]
 * @return {Stream} of objects of the form {url: string, data: Object, isLayout: boolean}
 */
function streamAssets(urls, concurrency = 1, headers) {
  return createStream(urls)
    .flatMap(url => {
      if (clayUtils.isComponent(url)) {
        return getDeepComponent(url, concurrency, headers);
      } else if (clayUtils.isPage(url)) {
        return streamPageAssets(url, concurrency, headers);
      } else if (clayUtils.isList(url) || clayUtils.isUser(url)) {
        return rest.get(url, {concurrency, headers}).map(data => ({url, data}));
      } else if (_.includes(url, '/uris/')) {
        return rest.get(url, {concurrency, type: 'text', headers}).map(data => ({url, data}));
      } else {
        return h.fromError(new Error(`Unable to GET ${url}: Must be a page, component, list, or user`));
      }
    })
    // drop any assets we've already streamed
    .uniqBy((a, b) => a.url === b.url)
    // fill in missing cmpt data (for cmpts found in pages)
    .flatMap(item => fillMissingData(item, concurrency, headers));
}

/**
 * Stream all the list URIs of the specified site.
 * @param {string} site
 * @return {Stream} of list URIs (strings)
 */
function streamListUris(site) {
  return rest.get(`${site}/lists`).flatten();
}

/**
 * Stream all the user URIs of the specified site.
 * @param {string} site
 * @return {Stream} of user URIs (strings)
 */
function streamUserUris(site) {
  return rest.get(`${site}/users`).flatten();
}

/**
* Stream all URL URIs.
* @param {string} site
* @return {Stream} of URL URIs (strings)
*/
function streamUris(site) {
  return rest.get(`${site}/uris`).flatten();
}

/**
 * Stream page URIs from a specified site's pages index, including
 * @published URIs.
 * @param {string} site
 * @param {Object} [opts]
 * @param {string} [opts.key] Site key
 * @param {number} [opts.limit] Number of pages to retrieve
 * @param {number} [opts.offset] Start at page
 * @param {number} [opts.concurrency]
 * @return {Stream} of page URIs (strings)
 */
function streamPageUris(site, {key, limit, offset, concurrency = 1} = {}) {
  const searchEndpoint = `${site}/_search`,
    postBody = {
      url: searchEndpoint,
      data: {
        index: 'pages',
        size: limit,
        from: offset,
        _source: ['uri', 'published'],
        body: {query: {prefix: {uri: urlUtil.urlToUri(site)}}}
      }
    };

  return rest.post(postBody, {key: config.getKey(key), concurrency})
    .map(result => result.hits.hits)
    .flatten()
    .map(hit => hit._source)
    .map(hit => hit.published ?
      [hit.uri, clayUtils.replaceVersion(hit.uri, 'published')] :
      [hit.uri]
    )
    .flatten();
}

/**
* GET the page at the specified URL, and return a stream of {url, data} Clay
* assets including the page asset itself and all page-level cmpts.
* Page cmpts will not have "data" initially; use fillMissingData.
* @param {string} url
* @param {number} [concurrency]
* @return {Stream}
**/
function streamPageAssets(url, concurrency = 1, headers) {
  const prefix = urlUtil.getUrlPrefix(url).prefix;

  return rest.get(url, {concurrency, headers})
    .flatMap((pageData) => {
      const childProps = _.omit(pageData, ['url', 'urlHistory', 'customUrl', 'lastModified', 'priority', 'changeFrequency', 'layout']),
        streams = [];

      if (pageData.layout) {
        streams.push(h([pageData.layout])
          .map(urlUtil.uriToUrl.bind(null, prefix))
          .map(url => ({url, isLayout: true}))
        );
      }

      if (!_.isEmpty(childProps)) {
        const childUris = _.reduce(childProps, (uris, area) => {
          return _.isArray(area) ? uris.concat(area) : uris;
        }, []);

        streams.push(h(childUris)
          .map(urlUtil.uriToUrl.bind(null, prefix))
          .map(url => ({url})));
      }

      streams.push(h([{
        url,
        data: pageData
      }]));
      return h(streams).mergeWithLimit(concurrency);
    });
}

/**
* Given a Clay asset in the form {url, data}, fill "data" if it is
* not yet set by retrieving data from "url".
* @param {Object} item of the form {url: string, data: Object}
* @param {number} [concurrency]
* @return {Stream} of {url, data} objects
**/
function fillMissingData(item, concurrency = 1, headers) {
  if (item.data) return h.of(item); // item already has data

  return rest.get(item.url + '.json', {concurrency, headers})
    .map(data => _.assign(item, {data})); // add data to item
}

module.exports.getComponentInstances = getComponentInstances;
module.exports.listComponentReferences = listComponentReferences;
module.exports.checkAllReferences = checkAllReferences;
module.exports.streamAssets = streamAssets;
module.exports.streamListUris = streamListUris;
module.exports.streamPageUris = streamPageUris;
module.exports.streamUserUris = streamUserUris;
module.exports.streamUris = streamUris;
module.exports.streamPageAssets = streamPageAssets;
