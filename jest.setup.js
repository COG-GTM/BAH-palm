import '@testing-library/jest-dom';
import { TextDecoder, TextEncoder } from 'util';

// jsdom does not provide these web globals, which @aws-sdk requires
global.TextEncoder = global.TextEncoder ?? TextEncoder;
global.TextDecoder = global.TextDecoder ?? TextDecoder;
const webStreams = require('stream/web');
global.TransformStream = global.TransformStream ?? webStreams.TransformStream;
global.ReadableStream = global.ReadableStream ?? webStreams.ReadableStream;
global.WritableStream = global.WritableStream ?? webStreams.WritableStream;

// Workaround to avoid warnings in the console about element.ref was removed in React 19
// TODO Remove this when Mantine is updated 
// https://github.com/mantinedev/mantine/issues/7028
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('element.ref was removed in React 19')) {
    return;
  }
  originalError(...args);
};

jest.mock('@azure/openai', () => ({
  OpenAIClient: jest.fn(),
}));

jest.mock('@azure/core-auth', () => ({
  AzureKeyCredential: jest.fn(),
}));
