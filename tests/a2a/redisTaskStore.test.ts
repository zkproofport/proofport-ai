import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '@a2a-js/sdk';
import type { RedisClient } from '../../src/redis/client.js';
import { RedisTaskStore } from '../../src/a2a/redisTaskStore.js';

describe('RedisTaskStore', () => {
  let mockRedis: Record<string, any>;
  let taskStore: RedisTaskStore;

  const mockTask: Task = {
    id: 'task-123',
    name: 'test-task',
    description: 'A test task',
  } as Task;

  beforeEach(() => {
    mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    };
    taskStore = new RedisTaskStore(mockRedis as RedisClient);
  });

  describe('save()', () => {
    it('stores Task as JSON in Redis with key a2a:task:{task.id} and TTL', async () => {
      await taskStore.save(mockTask);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `a2a:task:${mockTask.id}`,
        JSON.stringify(mockTask),
        'EX',
        86400
      );
    });

    it('uses default TTL of 86400 when not provided to constructor', async () => {
      const store = new RedisTaskStore(mockRedis as RedisClient);
      await store.save(mockTask);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `a2a:task:${mockTask.id}`,
        JSON.stringify(mockTask),
        'EX',
        86400
      );
    });

    it('uses custom TTL when provided to constructor', async () => {
      const customTTL = 3600;
      const store = new RedisTaskStore(mockRedis as RedisClient, customTTL);
      await store.save(mockTask);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `a2a:task:${mockTask.id}`,
        JSON.stringify(mockTask),
        'EX',
        customTTL
      );
    });

    it('serializes complex Task objects correctly', async () => {
      const complexTask: Task = {
        id: 'complex-task-456',
        name: 'complex-task',
        description: 'Task with nested data',
        metadata: {
          nested: {
            deeply: {
              value: 'test',
            },
          },
        },
      } as Task;

      await taskStore.save(complexTask);

      const callArgs = mockRedis.set.mock.calls[0];
      const storedData = JSON.parse(callArgs[1]);
      expect(storedData).toEqual(complexTask);
    });
  });

  describe('load()', () => {
    it('retrieves and parses Task from Redis', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(mockTask));

      const result = await taskStore.load(mockTask.id);

      expect(mockRedis.get).toHaveBeenCalledWith(`a2a:task:${mockTask.id}`);
      expect(result).toEqual(mockTask);
    });

    it('returns undefined when key not found', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await taskStore.load('nonexistent-task');

      expect(mockRedis.get).toHaveBeenCalledWith('a2a:task:nonexistent-task');
      expect(result).toBeUndefined();
    });

    it('parses complex Task objects correctly', async () => {
      const complexTask: Task = {
        id: 'complex-task-789',
        name: 'complex-task',
        description: 'Task with nested data',
        metadata: {
          array: [1, 2, 3],
          object: { key: 'value' },
        },
      } as Task;

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(complexTask));

      const result = await taskStore.load(complexTask.id);

      expect(result).toEqual(complexTask);
    });

    it('uses correct Redis key format', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(mockTask));
      const taskId = 'test-task-id-123';

      await taskStore.load(taskId);

      expect(mockRedis.get).toHaveBeenCalledWith(`a2a:task:${taskId}`);
    });
  });

  describe('setContextFlow()', () => {
    it('stores contextId→requestId mapping with key a2a:ctx:{contextId} and TTL', async () => {
      const contextId = 'ctx-123';
      const requestId = 'req-456';

      await taskStore.setContextFlow(contextId, requestId);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `a2a:ctx:${contextId}`,
        requestId,
        'EX',
        86400
      );
    });

    it('uses custom TTL for context flow', async () => {
      const customTTL = 7200;
      const store = new RedisTaskStore(mockRedis as RedisClient, customTTL);
      const contextId = 'ctx-456';
      const requestId = 'req-789';

      await store.setContextFlow(contextId, requestId);

      expect(mockRedis.set).toHaveBeenCalledWith(
        `a2a:ctx:${contextId}`,
        requestId,
        'EX',
        customTTL
      );
    });

    it('stores string values directly without JSON serialization', async () => {
      const contextId = 'ctx-999';
      const requestId = 'req-999';

      await taskStore.setContextFlow(contextId, requestId);

      const callArgs = mockRedis.set.mock.calls[0];
      expect(callArgs[1]).toBe(requestId); // Should be plain string, not JSON
    });
  });

  describe('getContextFlow()', () => {
    it('retrieves requestId from contextId', async () => {
      const contextId = 'ctx-123';
      const requestId = 'req-456';
      mockRedis.get.mockResolvedValueOnce(requestId);

      const result = await taskStore.getContextFlow(contextId);

      expect(mockRedis.get).toHaveBeenCalledWith(`a2a:ctx:${contextId}`);
      expect(result).toBe(requestId);
    });

    it('returns null when key not found', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await taskStore.getContextFlow('nonexistent-ctx');

      expect(mockRedis.get).toHaveBeenCalledWith('a2a:ctx:nonexistent-ctx');
      expect(result).toBeNull();
    });

    it('uses correct Redis key format for context flow', async () => {
      mockRedis.get.mockResolvedValueOnce('req-123');
      const contextId = 'ctx-flow-test-123';

      await taskStore.getContextFlow(contextId);

      expect(mockRedis.get).toHaveBeenCalledWith(`a2a:ctx:${contextId}`);
    });

    it('returns the stored value as-is (string)', async () => {
      const requestId = 'req-with-special-chars-!@#$%';
      mockRedis.get.mockResolvedValueOnce(requestId);

      const result = await taskStore.getContextFlow('ctx-123');

      expect(result).toBe(requestId);
    });
  });

  describe('integration', () => {
    it('can save and load tasks independently', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(mockTask));

      await taskStore.save(mockTask);
      const loaded = await taskStore.load(mockTask.id);

      expect(mockRedis.set).toHaveBeenCalledTimes(1);
      expect(mockRedis.get).toHaveBeenCalledTimes(1);
      expect(loaded).toEqual(mockTask);
    });

    it('can save context flow and task independently', async () => {
      mockRedis.get.mockResolvedValueOnce('req-123');

      await taskStore.save(mockTask);
      await taskStore.setContextFlow('ctx-123', 'req-123');
      const flowResult = await taskStore.getContextFlow('ctx-123');

      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      expect(flowResult).toBe('req-123');
    });
  });
});
