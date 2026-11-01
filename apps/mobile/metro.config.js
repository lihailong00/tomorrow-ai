const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const fs = require('fs');
const path = require('path');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const dependencyPath = path.join(__dirname, 'node_modules');
const sharedDependencies = fs.realpathSync(dependencyPath);
// Worktrees may share dependencies through a junction. Metro must index its
// real target as well as the application's own sources.
const config = sharedDependencies === dependencyPath ? {} : {
  watchFolders: [sharedDependencies],
  resolver: { nodeModulesPaths: [sharedDependencies] },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
