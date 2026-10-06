import { beforeEach, describe, expect, it, vi } from 'vitest';

const providers = vi.hoisted(() => ({
  getMeter: vi.fn(),
  getTracer: vi.fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: { getMeter: providers.getMeter },
  trace: { getTracer: providers.getTracer },
  SpanKind: { CLIENT: 2 },
  SpanStatusCode: { ERROR: 2, UNSET: 0 },
}));

describe('telemetry provider acquisition', () => {
  beforeEach(() => {
    vi.resetModules();
    providers.getMeter.mockReset();
    providers.getTracer.mockReset();
  });

  it('uses a provider registered after importing the telemetry helpers and caches instruments per meter', async () => {
    const { safeCounter } = await import('../../src/internal/safe-telemetry.js');
    expect(providers.getMeter).not.toHaveBeenCalled();

    const firstMeasurements: number[] = [];
    const firstMeter = {
      createCounter: vi.fn(() => ({ add: (value: number) => firstMeasurements.push(value) })),
    };
    providers.getMeter.mockReturnValue(firstMeter);

    safeCounter('anis.test.measurement', {});
    safeCounter('anis.test.measurement', {});

    expect(firstMeasurements).toEqual([1, 1]);
    expect(firstMeter.createCounter).toHaveBeenCalledTimes(1);

    const secondMeasurements: number[] = [];
    const secondMeter = {
      createCounter: vi.fn(() => ({ add: (value: number) => secondMeasurements.push(value) })),
    };
    providers.getMeter.mockReturnValue(secondMeter);
    safeCounter('anis.test.measurement', {});

    expect(secondMeasurements).toEqual([1]);
    expect(secondMeter.createCounter).toHaveBeenCalledTimes(1);
  });

  it('isolates providers whose meter and tracer acquisition throw at call time', async () => {
    providers.getMeter.mockImplementation(() => {
      throw new Error('meter provider failed');
    });
    providers.getTracer.mockImplementation(() => {
      throw new Error('tracer provider failed');
    });
    const { safeCounter, safeHistogram, withSafeSpan } = await import('../../src/internal/safe-telemetry.js');

    expect(providers.getMeter).not.toHaveBeenCalled();
    expect(providers.getTracer).not.toHaveBeenCalled();
    expect(() => {
      safeCounter('anis.test.measurement', {});
    }).not.toThrow();
    expect(() => {
      safeHistogram('anis.test.histogram', 1, {});
    }).not.toThrow();
    await expect(
      withSafeSpan('anis.test.span', async (span) => {
        await Promise.resolve();
        return span;
      }),
    ).resolves.toBeUndefined();
    expect(providers.getMeter).toHaveBeenCalledTimes(2);
    expect(providers.getTracer).toHaveBeenCalledTimes(1);
  });

  it('allows SDK import and an API call when provider acquisition throws', async () => {
    providers.getMeter.mockImplementation(() => {
      throw new Error('meter provider failed');
    });
    providers.getTracer.mockImplementation(() => {
      throw new Error('tracer provider failed');
    });
    const { AnisPartnersClient } = await import('../../src/index.js');

    expect(providers.getMeter).not.toHaveBeenCalled();
    expect(providers.getTracer).not.toHaveBeenCalled();
    const client = AnisPartnersClient.create({
      options: { authority: 'https://partners.example' },
      signer: {
        keyId: '2f1c8a94-6d37-4e52-b8a1-0c9e5d3f7b26',
        sign: () => Promise.resolve(new Uint8Array(64)),
      },
      fetch: () => Promise.reject(new TypeError('network unavailable')),
    });

    await expect(client.profile.get()).rejects.toBeDefined();
    expect(providers.getMeter).toHaveBeenCalled();
    expect(providers.getTracer).toHaveBeenCalled();
  });
});
