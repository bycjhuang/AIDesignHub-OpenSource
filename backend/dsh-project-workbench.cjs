'use strict';

const ENDPOINT_ENV = 'ADH_WORKBENCH_ENDPOINT';
const TOKEN_ENV = 'ADH_WORKBENCH_TOKEN';
const BUNDLE = Object.freeze({ scope: '@aidesign', name: 'dsh-project-workbench', dir: 'adh-project-workbench' });

function projectWorkbenchHostEnvironment(connection) {
  if (!connection) return { [ENDPOINT_ENV]: '', [TOKEN_ENV]: '' };
  let address;
  try { address = new URL(connection.endpoint); } catch { throw new Error('ADH 项目工作台桥地址无效。'); }
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port
      || address.pathname !== '/adh-workbench' || address.username || address.password || address.search || address.hash) {
    throw new Error('ADH 项目工作台只允许本机受保护的桥地址。');
  }
  if (typeof connection.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(connection.token)) throw new Error('ADH 项目工作台临时凭据无效。');
  return { [ENDPOINT_ENV]: address.href, [TOKEN_ENV]: connection.token };
}

function buildProjectWorkbenchEntries(enabled = true) {
  return [{ insert: [{ id: 'adh-project-workbench', name: `${BUNDLE.scope}/${BUNDLE.name}`,
    disabled: !enabled, config: { endpointEnv: ENDPOINT_ENV, tokenEnv: TOKEN_ENV } }] }];
}

module.exports = { PROJECT_WORKBENCH_BUNDLE: BUNDLE, buildProjectWorkbenchEntries, projectWorkbenchHostEnvironment };
