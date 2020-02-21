/*
  Copyright 2020 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import {executeQuotaErrorCallbacks} from 'workbox-core/_private/executeQuotaErrorCallbacks.js';
import {getFriendlyURL} from 'workbox-core/_private/getFriendlyURL.js';
import {timeout} from 'workbox-core/_private/timeout.js';
import {WorkboxError} from 'workbox-core/_private/WorkboxError.js';
import {logger} from 'workbox-core/_private/logger.js';

import {RouteHandlerCallbackOptions, WorkboxPlugin, WorkboxPluginCallbackParam} from 'workbox-core/types.js';
import {Deferred} from 'workbox-core/_private/Deferred.js';
import {Strategy} from './Strategy.js';
import './_version.js';


interface StrategyHandlerOptions extends RouteHandlerCallbackOptions {
  request: Request;
}

class StrategyHandler {
  public strategy: Strategy;
  public options: StrategyHandlerOptions;
  public pluginStateMap: Map<WorkboxPlugin, {[prop: string]: any}>;

  private readonly _extendLifetimePromises: Promise<any>[];
  private readonly _handlerDeferred: Deferred<any>;
  [key: string]: any;

  constructor(strategy: Strategy, options: StrategyHandlerOptions) {
    this.strategy = strategy;
    this.options = options;

    this._handlerDeferred = new Deferred();
    this._extendLifetimePromises = [];

    this.pluginStateMap = new Map();
    for (const plugin of strategy.plugins) {
      this.pluginStateMap.set(plugin, {});
    }

    if (this.options.event) {
      this.options.event.waitUntil(this._handlerDeferred.promise);
    }
  }

  waitUntil(promise: Promise<any>): void {
    this._extendLifetimePromises.push(promise);
  }

  async doneWaiting(): Promise<void> {
    let promise;
    while (promise = this._extendLifetimePromises.shift()) {
      await promise;
    }
  }

  destroy() {
    this._handlerDeferred.resolve();
  }

  async fetch(request: Request): Promise<Response> {
    const {event} = this.options;

    if (request.mode === 'navigate' &&
        event instanceof FetchEvent &&
        event.preloadResponse) {
      const possiblePreloadResponse = await event.preloadResponse;
      if (possiblePreloadResponse) {
        if (process.env.NODE_ENV !== 'production') {
          logger.log(`Using a preloaded navigation response for ` +
            `'${getFriendlyURL(request.url)}'`);
        }
        return possiblePreloadResponse;
      }
    }

    // If there is a fetchDidFail plugin, we need to save a clone of the
    // original request before it's either modified by a requestWillFetch
    // plugin or before the original request's body is consumed via fetch().
    const originalRequest = this.hasCallback('fetchDidFail') ?
        request.clone() : null;

    try {
      await this.eachCallback('requestWillFetch', async (callback) => {
        request = await callback({request: request.clone(), event});
      });
    } catch (err) {
      throw new WorkboxError('plugin-error-request-will-fetch', {
        thrownError: err,
      });
    }

    // The request can be altered by plugins with `requestWillFetch` making
    // the original request (most likely from a `fetch` event) different
    // from the Request we make. Pass both to `fetchDidFail` to aid debugging.
    const pluginFilteredRequest: Request = request.clone();

    try {
      let fetchResponse: Response;

      // See https://github.com/GoogleChrome/workbox/issues/1796
      fetchResponse = await fetch(request, request.mode === 'navigate' ?
          undefined : this.strategy.fetchOptions);

      if (process.env.NODE_ENV !== 'production') {
        logger.debug(`Network request for ` +
           `'${getFriendlyURL(request.url)}' returned a response with ` +
            `status '${fetchResponse.status}'.`);
      }

      await this.eachCallback('fetchDidSucceed', async (callback) => {
        fetchResponse = await callback({
          event,
          request: pluginFilteredRequest,
          response: fetchResponse,
        });
      })

      return fetchResponse;
    } catch (error) {
      if (process.env.NODE_ENV !== 'production') {
        logger.error(`Network request for `+
        `'${getFriendlyURL(request.url)}' threw an error.`, error);
      }

      // `originalRequest` will only exist if there's a `fetchDidFail` callback.
      if (originalRequest) {
        await this.runCallbacks('fetchDidFail', {
          error,
          event,
          originalRequest: originalRequest.clone(),
          request: pluginFilteredRequest.clone(),
        });
      }
      throw error;
    }
  }

  async fetchAndCachePut(request: Request): Promise<Response> {
    const response = await this.fetch(request);
    const responseClone = response.clone();

    this.waitUntil(this.cachePut(request, responseClone));

    return response;
  }

  /**
   * A wrapper around cache.match() that uses `matchOptions` and calls any
   * applicable plugins set on this instance.
   *
   * @param {Request} request The Request used to look up cache entries.
   * @return {Response} A cached response if available.
   * @memberof module:workbox-strategies
   */
  async cacheMatch(request: Request): Promise<Response | undefined> {
    let cachedResponse: Response | undefined;
    const {event} = this.options;
    const {cacheName, matchOptions} = this.strategy;

    const effectiveRequest = await this._getEffectiveRequest(request, 'read');

    cachedResponse = await caches.match(
        effectiveRequest, {...matchOptions, ...{cacheName}});

    if (process.env.NODE_ENV !== 'production') {
      if (cachedResponse) {
        logger.debug(`Found a cached response in '${cacheName}'.`);
      } else {
        logger.debug(`No cached response found in '${cacheName}'.`);
      }
    }

    await this.eachCallback('cachedResponseWillBeUsed', async (callback) => {
      cachedResponse = (await callback({
        cacheName,
        event,
        matchOptions,
        cachedResponse,
        request: effectiveRequest,
      })) || undefined;
    });

    return cachedResponse;
  }

  /**
   * Wrapper around cache.put().
   *
   * Will call `cacheDidUpdate` on plugins if the cache was updated, using
   * `matchOptions` when determining what the old entry is.
   *
   * @param {Object} options
   * @param {Request} options.request
   * @param {Response} options.response
   *
   * @memberof module:workbox-strategies
   */
  async cachePut(request: Request, response: Response): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      if (request.method && request.method !== 'GET') {
        throw new WorkboxError('attempt-to-cache-non-get-request', {
          url: getFriendlyURL(request.url),
          method: request.method,
        });
      }
    }

    // Run in the next task to avoid blocking other cache reads.
    // https://github.com/w3c/ServiceWorker/issues/1397
    await timeout(0);

    const effectiveRequest = await this._getEffectiveRequest(request, 'write');

    if (!response) {
      if (process.env.NODE_ENV !== 'production') {
        logger.error(`Cannot cache non-existent response for ` +
          `'${getFriendlyURL(effectiveRequest.url)}'.`);
      }

      throw new WorkboxError('cache-put-with-no-response', {
        url: getFriendlyURL(effectiveRequest.url),
      });
    }

    const responseToCache = await this._ensureResponseSafeToCache(response);

    if (!responseToCache) {
      if (process.env.NODE_ENV !== 'production') {
        logger.debug(`Response '${getFriendlyURL(effectiveRequest.url)}' ` +
        `will not be cached.`, responseToCache);
      }
      return;
    }

    const {cacheName} = this.strategy;
    const cache = await self.caches.open(cacheName);

    const oldResponse = this.hasCallback('cacheDidUpdate') ?
        await this.cacheMatch(request) : null;

    if (process.env.NODE_ENV !== 'production') {
      logger.debug(`Updating the '${cacheName}' cache with a new Response ` +
        `for ${getFriendlyURL(effectiveRequest.url)}.`);
    }

    try {
      await cache.put(effectiveRequest, responseToCache);
    } catch (error) {
      // See https://developer.mozilla.org/en-US/docs/Web/API/DOMException#exception-QuotaExceededError
      if (error.name === 'QuotaExceededError') {
        await executeQuotaErrorCallbacks();
      }
      throw error;
    }

    await this.runCallbacks('cacheDidUpdate', {
      cacheName,
      oldResponse,
      newResponse: responseToCache,
      request: effectiveRequest,
      event: this.options.event,
    });
  }

  async runCallbacks<C extends keyof NonNullable<WorkboxPlugin>>(
    name: C,
    param: Omit<WorkboxPluginCallbackParam[C], 'state'>,
  ): Promise<void> {
    for (const plugin of this.strategy.plugins) {
      if (typeof plugin[name] === 'function') {
        const state = this.pluginStateMap.get(plugin);
        const statefulParam = {...param, state};

        // TODO(philipwalton): not sure why `any` is needed. It seems like
        // this should work with `as WorkboxPluginCallbackParam[C]`.
        (plugin[name]!)(statefulParam as any);
      }
    }
  }

  async eachCallback<C extends keyof WorkboxPlugin>(
    name: C,
    executor: (callback: NonNullable<WorkboxPlugin[C]>) => Promise<void>,
  ): Promise<void> {
    for (const plugin of this.strategy.plugins) {
      if (typeof plugin[name] === 'function') {
        const state = this.pluginStateMap.get(plugin);
        const statefulCallback = (param: Omit<WorkboxPluginCallbackParam[C], 'state'>) => {
          const statefulParam = {...param, state};

          // TODO(philipwalton): not sure why `any` is needed. It seems like
          // this should work with `as WorkboxPluginCallbackParam[C]`.
          return plugin[name]!(statefulParam as any);
        }
        // TODO(philipwalton): not sure why `any` is needed. It seems like
        // this should work with `as WorkboxPlugin[C]`.
        await executor(statefulCallback as any);
      }
    }
  }

  hasCallback<C extends keyof WorkboxPlugin>(name: C): boolean {
    for (const plugin of this.strategy.plugins) {
      if (name in plugin) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks the list of plugins for the cacheKeyWillBeUsed callback, and
   * executes any of those callbacks found in sequence. The final `Request`
   * object returned by the last plugin is treated as the cache key for cache
   * reads and/or writes.
   *
   * @param {Request} request
   * @param {string} mode
   * @return {Promise<Request>}
   *
   * @private
   */
  async _getEffectiveRequest(request: Request, mode: string): Promise<Request> {
    let effectiveRequest = request;
    await this.eachCallback('cacheKeyWillBeUsed', async (callback) => {
      const ret = await callback({
        mode,
        request: effectiveRequest,
        event: this.options.event
      });
      effectiveRequest = typeof ret === 'string' ? new Request(ret) : ret;
    });
    return effectiveRequest;
  }

  /**
   * This method will call cacheWillUpdate on the available plugins (or use
   * status === 200) to determine if the Response is safe and valid to cache.
   *
   * @param {Request} options.request
   * @param {Response} options.response
   * @return {Promise<Response|undefined>}
   *
   * @private
   */
  async _ensureResponseSafeToCache(response: Response): Promise<Response | undefined> {
    let responseToCache: Response | undefined = response;
    let pluginsUsed = false;

    await this.eachCallback('cacheWillUpdate', async (callback) => {
      // TODO(philipwalton): using a loop and `break` would be cleaner.
      if (responseToCache) {
        responseToCache = (await callback({
          request: this.options.request,
          response: responseToCache,
          event: this.options.event,
        })) || undefined;
        pluginsUsed = true;
      }
    });

    if (!pluginsUsed) {
      if (responseToCache && responseToCache.status !== 200) {
        responseToCache = undefined;
      }
      if (process.env.NODE_ENV !== 'production') {
        if (responseToCache) {
          if (responseToCache.status !== 200) {
            if (responseToCache.status === 0) {
              logger.warn(`The response for '${this.options.request.url}' ` +
                  `is an opaque response. The caching strategy that you're ` +
                  `using will not cache opaque responses by default.`);
            } else {
              logger.debug(`The response for '${this.options.request.url}' ` +
                  `returned a status code of '${response.status}' and won't ` +
                  `be cached as a result.`);
            }
          }
        }
      }
    }

    return responseToCache;
  }
}

export {StrategyHandler}
