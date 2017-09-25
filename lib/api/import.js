const deepEqual = require('deep-equal'),
  clayInput = require('../io/input-clay'),
  h = require('highland'),
  urlUtil = require('../utils/urls'),
  _ = require('lodash'),
  chunks = require('../io/agnostic-chunks'),
  rest = require('../utils/rest');

/**
* Error handler. If err represents 404 error, pass fnc(). Otherwise, push error.
* @param {function} fnc
* @returns {function}
*/
function pass404(fnc) {
  return (err, push) => {
    if (_.get(err, 'response.status') === 404) {
      return fnc();
    } else {
      push(err);
    }
  };
}

/**
 * Import data from a single component/page url.
 * @param {string} url
 * @param {string} prefix of target site
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {string} [opts.key] Authorization key for target site
 * @param {object} [opts.headers] Custom headers for PUT requests to target site
 * @param {boolean} [opts.overwriteLayouts] Overwrite layouts in target site
 * @return {Stream}
 */
function importUrl(url, prefix, {concurrency, key, headers, overwriteLayouts}) {
  return clayInput.importUrl(url, concurrency)
    .flatMap(chunks.replacePrefixes(prefix))
    .flatFilter(overwriteLayouts ?
      // pass everything through
      i => i :
      // throw out layouts that already exist in target site
      filterExistingLayouts({concurrency, key, headers})
    )
    .flatMap(item => rest.put(item, {key, concurrency, type: 'json', headers}));

  return stream;
}

/**
 * Returns a filter function that removes from a stream of
 * {url: string, data: object, isLayout: boolean} objects
 * any layout instances that already exist.
 * @param {Object} argv
 * @return {function}
 */
function filterExistingLayouts({concurrency, headers, key}) {
  return (item) => {
    // pass anything that's not a layout
    if (!item.isLayout) return h.of(true);
    // check if list exists and pass anything that doesn't
    return rest.get(item.url, {concurrency, headers, key, type: 'json'})
      .errors(pass404(() => h.of(true)))
      // if it does exist, remove
      .flatMap(() => h.of(false));
  };
}

/**
 * Import lists from one site to another. Merge with existing lists.
 * @param {string} sourceSite Source site prefix
 * @param {string} prefix Target site prefix
 * @param {object} [opts]
 * @param {string} [opts.key] Authorization key of target site
 * @param {number} [opts.concurrency]
 * param {Object} [opts.headers] Custom headers for PUT requests
 * @return {Stream} of rest.put results, i.e. {result: string, url: string} objects
 */
function importLists(sourceSite, prefix, {key, concurrency, headers}) {
  return clayInput.getListsInSite(sourceSite)
    .flatMap(listUri => importList(listUri, sourceSite, prefix, {key, concurrency, headers}));
}

/**
 * Merge the list at listUri into the target site.
 * @param {string} listUri Uri of source site list
 * @param {string} sourceSite Source site prefix
 * @param {string} prefix Target site prefix
 * @param {object} [opts]
 * @param {string} [opts.key] Authorization key of target site
 * @param {number} [opts.concurrency]
 * @param {object} [opts.headers] Custom headers for PUT requests
 * @return {Stream} of rest.put results, i.e. {result: string, url: string} objects
 */
function importList(listUri, sourceSite, prefix, {key, concurrency, headers}) {
  const sourceUrl = urlUtil.uriToUrl(sourceSite, listUri),
    targetUrl = prefix + '/lists/' + listUri.split('/lists/')[1];

  return h([sourceUrl, targetUrl])
    .flatMap(rest.get)
    .errors(pass404(() => [])) // if either list 404s, act as if empty
    .flatten()
    .uniqBy(deepEqual) // remove dups between source and target
    .collect()
    .map(newList => ({
      url: targetUrl,
      data: JSON.stringify(newList)
    }))
    .flatMap(putItems => rest.put(putItems, {key, concurrency, headers, type: 'json'}));
}

/**
 * Import all pages from a site to a target site.
 * @param {string} sourceSite Prefix of site to import from
 * @param {string} prefix Prefix of site to import to
 * @param {object} [opts]
 * @param {number} [opts.limit] Number of pages to import
 * @param {number} [opts.offset] Number of pages in source site to skip
 * @param {number} [opts.concurrency]
 * @param {number} [opts.key] Authorization key of target site
 * @param {number} [opts.sourceKey] Authorization key of source site
 * @param {boolean} [opts.published] Include published pages
 * @param {boolean} [opts.overwriteLayouts] Overwrite layouts in target site
 * @return {Stream} of rest.put {result: string, url: string} objects
 */
function importPages(sourceSite, prefix, {limit, offset, concurrency, key, sourceKey, published, overwriteLayouts} = {}) {

  return clayInput.getPagesInSite(sourceSite, {key: sourceKey, limit, offset})
    .map(page => published && page.published ?
      [page.uri, page.uri + '@published'] :
      [page.uri]
    )
    .flatten()
    .map(pageUri => urlUtil.uriToUrl(sourceSite, pageUri))
    .flatMap(pageUrl => importUrl(pageUrl, prefix, {concurrency, key, overwriteLayouts}));
}

/**
 * Import all pages from a site and, optionally, all lists.
 * @param {string} site Prefix of site to import from
 * @param {string} prefix Prefix of site to import to
 * @param {object} [opts]
 * @param {number} [opts.limit] Number of pages to import
 * @param {number} [opts.offset] Number of pages in source site to skip
 * @param {number} [opts.concurrency]
 * @param {number} [opts.key] Authorization key of target site
 * @param {number} [opts.sourceKey] Authorization key of source site
 * @param {boolean} [opts.published] Include published pages
 * @param {boolean} [opts.overwriteLayouts] Overwrite layouts in target site
 * @param {boolean} [opts.lists] Include lists
 * @return {Stream} of rest.put {result: string, url: string} objects
 */
function importSite(site, prefix, {limit, offset, concurrency, key, sourceKey, overwriteLayouts, published, lists} = {}) {
  let streams = [];

  streams.push(importPages(site, prefix, {
    limit, offset, concurrency, key, sourceKey, overwriteLayouts, published
  }));
  if (lists) {
    streams.push(importLists(site, prefix, {concurrency, key}));
  }
  return h(streams).merge();
}

module.exports.importSite = importSite;
module.exports.importPages = importPages;
module.exports.importLists = importLists;
module.exports.importList = importList;
module.exports.importUrl = importUrl;