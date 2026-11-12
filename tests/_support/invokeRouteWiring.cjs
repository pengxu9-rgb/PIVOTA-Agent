'use strict';

// Who serves the invoke handler, and through what.
//
// Two scans, because neither alone is enough:
//   - the ROUTER scan reads the app's own route table, so it sees what is really registered (an address, its
//     handlers, their order), but it can only recognise the invoke handler by the two registration functions'
//     handlers;
//   - the SOURCE scan reads src/server.js, so it sees a handler call written anywhere else, which the router
//     scan could not tell from any other anonymous route.
// tests/invoke_route_alias_parity.node.test.cjs runs both, and proves each one against a wrong registration.

const crypto = require('node:crypto');
const ts = require('typescript');

// The handlers the two registration functions put on an address, by name.
const STRICT_HANDLER = 'commerceStrictInvokeRouteHandler';
const INVOKE_HANDLER = 'externalInvokeRouteHandler';

function fingerprint(fn) {
  return crypto.createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex').slice(0, 12);
}

function routerStack(app) {
  const stack = app && app._router && app._router.stack;
  if (!Array.isArray(stack)) throw new Error('the app has no router stack to scan');
  return stack;
}

/** Every address with a route that carries one of the two invoke handlers. */
function invokeAddresses(app) {
  const out = [];
  for (const layer of routerStack(app)) {
    if (!layer.route) continue;
    const names = layer.route.stack.map((h) => h.name);
    if (!names.includes(STRICT_HANDLER) && !names.includes(INVOKE_HANDLER)) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const p of paths) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Everything a request to `path` passes, in order: each app-level middleware that matches the path and each
 * handler of each route registered for it. A handler is named by its function name AND a hash of its source,
 * so two different anonymous functions never look alike; a route handler also carries its method.
 */
function handlerChain(app, path) {
  const chain = [];
  for (const layer of routerStack(app)) {
    if (!layer.match(path)) continue;
    if (!layer.route) {
      chain.push({ kind: 'use', name: layer.name || '<anonymous>', source: fingerprint(layer.handle) });
      continue;
    }
    for (const h of layer.route.stack) {
      chain.push({ kind: 'route', method: h.method || 'all', name: h.name || '<anonymous>', source: fingerprint(h.handle) });
    }
  }
  return chain;
}

const describe = (chain) => chain.map((h) => (h.kind === 'route' ? `${h.method}:${h.name}#${h.source}` : `use:${h.name}#${h.source}`));
const routeHandlers = (chain) => chain.filter((h) => h.kind === 'route').map((h) => `${h.method}:${h.name}`);

/**
 * The problems in how the app serves the invoke handler. Empty when every address in `routes` (and no other
 * address) serves it through exactly `expectedRouteHandlers`, with a chain identical to the first address's.
 */
function invokeRouteWiringProblems(app, { routes, expectedRouteHandlers }) {
  const problems = [];
  const listed = routes.map((r) => r.path);
  const served = invokeAddresses(app);
  for (const p of served) if (!listed.includes(p)) problems.push(`${p} serves the invoke handler but is not in the shared list`);
  for (const p of listed) if (!served.includes(p)) problems.push(`${p} is in the shared list but serves no invoke handler`);
  if (new Set(listed).size !== listed.length) problems.push('the shared list names an address twice');

  const reference = listed[0];
  const referenceChain = describe(handlerChain(app, reference));
  for (const p of new Set([...listed, ...served])) {
    const chain = handlerChain(app, p);
    const handlers = routeHandlers(chain);
    if (JSON.stringify(handlers) !== JSON.stringify(expectedRouteHandlers)) {
      problems.push(`${p} route handlers are [${handlers.join(', ')}], expected [${expectedRouteHandlers.join(', ')}]`);
    }
    const described = describe(chain);
    if (JSON.stringify(described) !== JSON.stringify(referenceChain)) {
      const missing = referenceChain.filter((h) => !described.includes(h));
      const extra = described.filter((h) => !referenceChain.includes(h));
      problems.push(
        `${p} does not pass what ${reference} passes: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`
          + (missing.length || extra.length ? '' : ' (same handlers, different order)'),
      );
    }
  }
  return problems;
}

// ---- source scan ---------------------------------------------------------------------------------------

const HANDLER = 'handleInvokeRequest';
const REGISTER_STRICT = 'registerCommerceStrictInvokeRoute';
const REGISTER_INVOKE = 'registerExternalInvokeRoute';
const REGISTER_ALL = 'registerInvokeRoutes';
const ROUTE_LIST = 'INVOKE_ROUTES';
// The one other caller of the handler: the product-search GET route, which builds the request body itself and
// always names the same read operation. It cannot be asked for any other operation.
const FIXED_OPERATION_DOOR = { fn: 'handleAgentProductsSearchViaInvoke', operation: 'find_products_multi' };

function topLevelFunctionOf(node) {
  let fn = null;
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name && ts.isSourceFile(n.parent)) fn = n.name.text;
  }
  return fn;
}

/** The problems in how src/server.js reaches the invoke handler. Empty when only the shared loop does. */
function invokeRegistrationSourceProblems(source) {
  const sf = ts.createSourceFile('server.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const problems = [];
  const calls = { [HANDLER]: [], [REGISTER_STRICT]: [], [REGISTER_INVOKE]: [], [REGISTER_ALL]: [] };
  const otherUses = { [HANDLER]: [], [REGISTER_STRICT]: [], [REGISTER_INVOKE]: [], [REGISTER_ALL]: [] };
  let fixedDoorNamesItsOperation = false;

  (function walk(node) {
    if (ts.isIdentifier(node) && Object.prototype.hasOwnProperty.call(calls, node.text)) {
      const parent = node.parent;
      const isDeclaration = ts.isFunctionDeclaration(parent) && parent.name === node;
      const isCallee = ts.isCallExpression(parent) && parent.expression === node;
      // `obj.handleInvokeRequest` and `{ handleInvokeRequest: x }` name a property, not this function.
      const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (isCallee) calls[node.text].push(parent);
      else if (!isDeclaration && !isPropertyName) otherUses[node.text].push(node);
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'operation'
        && ts.isStringLiteral(node.initializer) && node.initializer.text === FIXED_OPERATION_DOOR.operation
        && topLevelFunctionOf(node) === FIXED_OPERATION_DOOR.fn) {
      fixedDoorNamesItsOperation = true;
    }
    ts.forEachChild(node, walk);
  })(sf);

  // 1. The handler is called from the invoke registration and from the fixed-operation door, nowhere else,
  //    and is never handed around under another name.
  for (const call of calls[HANDLER]) {
    const fn = topLevelFunctionOf(call);
    if (fn !== REGISTER_INVOKE && fn !== FIXED_OPERATION_DOOR.fn) {
      problems.push(`line ${line(call)}: ${HANDLER} is called from ${fn || 'the top level'}, outside ${REGISTER_INVOKE}`);
    }
  }
  if (calls[HANDLER].filter((c) => topLevelFunctionOf(c) === REGISTER_INVOKE).length !== 1) {
    problems.push(`${REGISTER_INVOKE} must call ${HANDLER} exactly once`);
  }
  if (calls[HANDLER].some((c) => topLevelFunctionOf(c) === FIXED_OPERATION_DOOR.fn) && !fixedDoorNamesItsOperation) {
    problems.push(`${FIXED_OPERATION_DOOR.fn} no longer sets operation '${FIXED_OPERATION_DOOR.operation}' itself`);
  }
  for (const use of otherUses[HANDLER]) problems.push(`line ${line(use)}: ${HANDLER} is referenced without being called`);

  // 2. Each registration function is called once, inside the shared loop over the list, strict first.
  for (const name of [REGISTER_STRICT, REGISTER_INVOKE]) {
    if (calls[name].length !== 1) {
      problems.push(`${name} is called ${calls[name].length} times (lines ${calls[name].map(line).join(', ') || '-'}), expected once`);
    }
    for (const call of calls[name]) {
      // A plain statement of the loop's own body: not under a condition, not in a nested function.
      const statement = call.parent;
      const body = statement && statement.parent;
      const loop = body && body.parent;
      const inLoop = Boolean(loop) && ts.isExpressionStatement(statement) && ts.isBlock(body) && ts.isForOfStatement(loop)
        && ts.isIdentifier(loop.expression) && loop.expression.text === ROUTE_LIST;
      if (topLevelFunctionOf(call) !== REGISTER_ALL) {
        problems.push(`line ${line(call)}: ${name} is called outside the loop over ${ROUTE_LIST} in ${REGISTER_ALL}`);
      } else if (!inLoop) {
        problems.push(`line ${line(call)}: ${name} is not an unconditional statement of the loop over ${ROUTE_LIST}`);
      }
    }
    // The only other mention allowed is the test export.
    const stray = otherUses[name].filter((use) => !ts.isShorthandPropertyAssignment(use.parent));
    for (const use of stray) problems.push(`line ${line(use)}: ${name} is referenced without being called`);
  }
  if (calls[REGISTER_STRICT].length === 1 && calls[REGISTER_INVOKE].length === 1
      && calls[REGISTER_STRICT][0].getStart(sf) > calls[REGISTER_INVOKE][0].getStart(sf)) {
    problems.push(`${REGISTER_INVOKE} is registered before ${REGISTER_STRICT}: the strict route would never see a request`);
  }

  // 3. The shared loop runs once, from the top level.
  if (calls[REGISTER_ALL].length !== 1) problems.push(`${REGISTER_ALL} is called ${calls[REGISTER_ALL].length} times, expected once`);
  for (const call of calls[REGISTER_ALL]) {
    if (topLevelFunctionOf(call) !== null || call.arguments.length !== 0) {
      problems.push(`line ${line(call)}: ${REGISTER_ALL} must be called from the top level with no arguments`);
    }
  }
  for (const use of otherUses[REGISTER_ALL]) problems.push(`line ${line(use)}: ${REGISTER_ALL} is referenced without being called`);
  return problems;
}

module.exports = {
  STRICT_HANDLER,
  INVOKE_HANDLER,
  invokeAddresses,
  handlerChain,
  routeHandlers,
  invokeRouteWiringProblems,
  invokeRegistrationSourceProblems,
};
