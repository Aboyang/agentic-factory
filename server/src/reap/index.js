import { config } from '../config.js';
import { reapLive } from './client.js';
import { reapMock } from './mock.js';

export const reap = config.mockReap ? reapMock : reapLive;
export const isMockReap = config.mockReap;
