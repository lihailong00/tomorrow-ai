// Jest has no native storage bridge. Use the dependency's official in-memory double.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
