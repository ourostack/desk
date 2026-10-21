// Correlation/pending mechanics derived from ourostack/desk
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f, native-cdp.mjs's generic
// NativeCommandTransport only. No CDP/lease engine is carried across.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BrokerError } from '../util/broker-error.mjs';
import { encodeNativeMessage } from './native-host.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const CONTEXT = new Set(['context.create', 'context.resume', 'context.status', 'context.label', 'context.discard']);
const PROVIDER = new Set(['profile.read', 'extension.reload', 'extension.reload.commit', 'transition.capture', 'transition.release']);
const REMOTE_CODES = new Set([
  'native_browser_operation_failed', 'native_cdp_method_denied', 'native_cleanup_unconfirmed',
  'native_close_unconfirmed', 'native_discard_incomplete', 'native_context_busy', 'native_context_duplicate', 'native_context_create_failed',
  'native_context_ownership_changed', 'native_context_parameters_invalid', 'native_context_unavailable',
  'native_debugger_cleanup_unconfirmed', 'native_debugger_custody_busy', 'native_extension_stopped',
  'native_group_custody_unknown', 'native_group_not_owned', 'native_group_unconfirmed',
  'native_inactive_tab_unconfirmed', 'native_normal_window_unavailable', 'native_opener_admission_failed',
  'native_profile_mismatch', 'native_profile_token_invalid', 'native_relay_request_invalid',
  'native_relay_unavailable', 'native_session_not_owned', 'native_source_mismatch', 'native_tab_admission_failed',
  'native_target_not_owned', 'native_target_unavailable', 'native_token_document_invalid',
  'native_transport_disconnected', 'native_update_effects_pending', 'native_update_pending', 'native_update_token_invalid',
  'native_request_invalid', 'native_request_busy', 'native_operation_failed', 'native_task_create_failed', 'native_method_denied',
  'native_transition_pending', 'native_transition_changed', 'native_transition_unavailable',
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Preserve structured resource obligations, not raw native exceptions, URLs or
// credentials accidentally embedded in a resource's descriptive string.
function safeResources(value, depth = 0) {
  if (depth > 16) return '<bounded>';
  if (typeof value === 'string')
    return value.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, '<redacted-url>')
      .replace(/[a-f0-9]{64,}/giu, '<redacted>').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 4096);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(item => safeResources(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [safeResources(key, depth + 1), safeResources(item, depth + 1)]));
  return null;
}

export class NativeCommandTransport extends EventEmitter {
  constructor({ send, timeoutMs = 10_000 }) {
    super();
    if (typeof send !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
      throw new BrokerError('INVALID_NATIVE_TRANSPORT', 'Native transport requires a sender and bounded request deadline');
    this.send = send; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.closed = false;
  }

  request(request) {
    if (this.closed) return Promise.reject(new BrokerError('NATIVE_TRANSPORT_DISCONNECTED', 'Native transport is disconnected'));
    const { method, contextId, leaseId, params = {} } = object(request) ? request : {};
    if (!object(request) || Object.keys(request).some(key => !['method', 'contextId', 'leaseId', 'params'].includes(key)) ||
        (!CONTEXT.has(method) && !PROVIDER.has(method)) ||
        (CONTEXT.has(method) ? typeof contextId !== 'string' || !UUID.test(contextId) : Object.hasOwn(request, 'contextId')) ||
        (Object.hasOwn(request, 'leaseId') && (typeof leaseId !== 'string' || !ROUTE.test(leaseId))) || !object(params))
      return Promise.reject(new BrokerError('NATIVE_REQUEST_INVALID', 'Native request requires exact context or provider scope'));
    if (this.pending.size >= 256) return Promise.reject(new BrokerError('NATIVE_QUEUE_FULL', 'Native IPC queue is full'));
    const id = randomUUID();
    let outgoing;
    try {
      outgoing = JSON.parse(encodeNativeMessage({
        id, method, ...(CONTEXT.has(method) ? { contextId } : {}),
        ...(leaseId === undefined ? {} : { leaseId }), params,
      }).subarray(4).toString('utf8'));
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, dispatched: false,
        request: { id, method, ...(CONTEXT.has(method) ? { contextId } : {}) } };
      pending.timer = setTimeout(() => this.failPending(id, 'NATIVE_REQUEST_TIMEOUT'), this.timeoutMs);
      pending.timer.unref();
      this.pending.set(id, pending);
      Promise.resolve().then(() => {
        if (!this.pending.has(id)) return;
        pending.dispatched = true; // a failed write can have delivered bytes
        return this.send(outgoing);
      }).catch(() => this.failPending(id, 'NATIVE_SEND_FAILED'));
    });
  }

  failPending(id, code) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id); clearTimeout(pending.timer);
    const disposition = pending.dispatched ? 'unknown' : 'not-dispatched';
    const resources = { ...(pending.request.contextId ? { contextId: pending.request.contextId } : {}), disposition };
    const error = new BrokerError(code, code, { effect: disposition, request: pending.request, resources });
    error.resources = resources;
    pending.reject(error);
    return true;
  }

  receive(message) {
    if (this.closed || !object(message)) return false;
    try { encodeNativeMessage(message); } catch { return false; }
    if (typeof message.event === 'string') {
      this.emit('event', message);
      return true;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    const hasResult = Object.hasOwn(message, 'result'), hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError || (hasError && (!object(message.error) ||
        typeof message.error.code !== 'string' || typeof message.error.message !== 'string'))) {
      return this.failPending(message.id, 'NATIVE_RESPONSE_INVALID');
    }
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (hasError) {
      const code = REMOTE_CODES.has(message.error.code) ? message.error.code : 'NATIVE_REMOTE_ERROR';
      const resources = Object.hasOwn(message.error, 'resources') ? safeResources(message.error.resources) : undefined;
      const error = new BrokerError(code, code, {
        request: pending.request, ...(resources === undefined ? {} : { resources }),
      });
      if (resources !== undefined) error.resources = resources;
      pending.reject(error);
    } else pending.resolve(message.result);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.failPending(id, 'NATIVE_TRANSPORT_DISCONNECTED');
    this.emit('close');
  }
}
