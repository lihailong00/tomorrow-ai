module.exports = {
  preset: 'react-native',
  setupFiles: ['@shopify/flash-list/jestSetup', '<rootDir>/test/nativeStorageSetup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:\\.pnpm|react-native|@react-native|@react-native-community|@shopify/flash-list)/)',
  ],
};
