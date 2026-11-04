const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const root = path.resolve(__dirname, '../..');

const config = {
  watchFolders: [root],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    extraNodeModules: new Proxy(
      {},
      { get: (_, name) => path.join(__dirname, 'node_modules', String(name)) },
    ),
    blockList: [
      new RegExp(`${root}/node_modules/.*`),
      new RegExp(`${root}/example/.*/android/.*`),
      new RegExp(`${root}/example/.*/ios/Pods/.*`),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
