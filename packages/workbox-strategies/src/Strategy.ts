/*
  Copyright 2020 Google LLC

  Use of this source code is governed by an MIT-style
  license that can be found in the LICENSE file or at
  https://opensource.org/licenses/MIT.
*/

import {cacheNames} from 'workbox-core/_private/cacheNames.js';
import {RouteHandlerObject, WorkboxPlugin} from 'workbox-core/types.js';
import {StrategyHandler} from './StrategyHandler.js';
import './_version.js';


export interface StrategyOptions {
  cacheName?: string;
  plugins?: WorkboxPlugin[];
  fetchOptions?: RequestInit;
  matchOptions?: CacheQueryOptions;
}

type StrategyHandleLooseOptions = FetchEvent | {
  request: Request | string;
  event?: ExtendableEvent;
}

type StrategyHandleOptions = {
  request: Request;
  event?: ExtendableEvent;
  response?: Response;
}

abstract class Strategy implements RouteHandlerObject {
  cacheName: string; // TODO: make protected.
  plugins: WorkboxPlugin[]; // TODO: make protected.
  fetchOptions?: RequestInit; // TODO: make protected.
  matchOptions?: CacheQueryOptions; // TODO: make protected.
  protected abstract _handle(
    request: Request,
    handler: StrategyHandler
  ): Promise<Response>;

  /**
   * @param {Object} options
   * @param {string} options.cacheName Cache name to store and retrieve
   * requests. Defaults to cache names provided by
   * [workbox-core]{@link module:workbox-core.cacheNames}.
   * @param {Array<Object>} options.plugins [Plugins]{@link https://developers.google.com/web/tools/workbox/guides/using-plugins}
   * to use in conjunction with this caching strategy.
   * @param {Object} options.fetchOptions Values passed along to the
   * [`init`](https://developer.mozilla.org/en-US/docs/Web/API/WindowOrWorkerGlobalScope/fetch#Parameters)
   * of all fetch() requests made by this strategy.
   * @param {Object} options.matchOptions [`CacheQueryOptions`](https://w3c.github.io/ServiceWorker/#dictdef-cachequeryoptions)
   */
  constructor(options: StrategyOptions = {}) {
    this.cacheName = cacheNames.getRuntimeName(options.cacheName);
    this.plugins = options.plugins || [];
    this.fetchOptions = options.fetchOptions;
    this.matchOptions = options.matchOptions;
  }

  /**
   * This method will perform a request strategy and follows an API that
   * will work with the
   * [Workbox Router]{@link module:workbox-routing.Router}.
   *
   * @param {Object} options
   * @param {Request|string} options.request A request to run this strategy for.
   * @param {Event} [options.event] The event that triggered the request.
   * @return {Promise<Response>}
   */
  handle(options: StrategyHandleLooseOptions): Promise<Response> {
    return this.run(options).response;
  }

  run(options: StrategyHandleLooseOptions): {
    response: Promise<Response>;
    done: Promise<void>;
  } {
    // Allow for flexible options to be passed.
    if (options instanceof FetchEvent) {
      options = {
        event: options,
        request: options.request,
      };
    } else {
      // `options.request` can be a string, similar to what `fetch()` accepts.
      if (typeof options.request === 'string') {
        options.request = new Request(options.request);
      }
    }

    const {event, request} = options as StrategyHandleOptions;
    const handler = new StrategyHandler(this, {event, request});

    const responseDone = this._getResponse(handler, request, event);
    const handlerDone = this._awaitComplete(responseDone, handler, request, event);

    return {
      response: responseDone,
      done: handlerDone,
    };
  }

  async _getResponse(handler: StrategyHandler, request: Request, event?: ExtendableEvent) {
    await handler.runCallbacks('handlerWillStart', {event, request});
    let response = await this._handle(request, handler);
    handler.eachCallback('handlerWillRespond', async (callback) => {
      response = await callback({event, request, response});
    });
    return response;
  }

  async _awaitComplete(responseDone: Promise<Response>, handler: StrategyHandler, request: Request, event?: ExtendableEvent) {
    let response;
    let error;
    try {
      response = await responseDone;

      await handler.runCallbacks('handlerDidRespond', {event, request, response});
      await handler.doneWaiting();
    } catch (responseError) {
      // Ensure the handler is destroyed even in the case  of an error
      // (otherwise `event.waitUntil()` would never resolve).
      error = responseError;
    }

    await handler.runCallbacks('handlerDidComplete', {event, request, response, error});
    handler.destroy();
  }
}

export {Strategy}
