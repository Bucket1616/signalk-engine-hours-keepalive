'use strict'

module.exports = function (app) {
  const plugin = {}
  let options = {}
  let engines = []
  let unsubscribes = []

  plugin.id = 'signalk-engine-hours-keepalive'
  plugin.name = 'Engine Hours Keepalive'
  plugin.description =
    'Re-emits engine hours when engines stop transmitting so downstream devices retain latest hours.'

  // --------------------
  // Plugin schema
  // --------------------
  plugin.schema = {
    type: 'object',
    properties: {
      startDelaySeconds: {
        type: 'number',
        title: 'Silence delay before keepalive starts (seconds)',
        default: 6
      },
      transmitIntervalSeconds: {
        type: 'number',
        title: 'Transmit interval (seconds)',
        default: 3
      },
      discoverOnly: {
        type: 'boolean',
        title: 'Discovery only - Results Appear on Dashboard (NO KEEPALIVE INJECTION!)',
        default: false
      },
      keepaliveFields: {
        type: 'array',
        title: 'Optional fields to include with engine keepalive PGN',
        description:
          'These fields will be faked using 0 or last-known values to ensure N2K PGN emission when engine is off.',
        items: {
          type: 'string',
          enum: ['revolutions', 'oilPressure', 'oilTemperature', 'temperature', 'fuelRate']
        },
        default: ['revolutions', 'oilPressure', 'fuelRate']
      },
      engines: {
        type: 'array',
        title: 'Engines',
        maxItems: 6,
        items: {
          type: 'object',
          required: ['path'],
          properties: {
            name: {
              type: 'string',
              title: 'Engine name (optional)'
            },
            path: {
              type: 'string',
              title: 'Runtime path (Signal K)',
              description:
                'Example: propulsion.port.runTime'
            }
          }
        }
      }
    }
  }

  // --------------------
  // Startup
  // --------------------
  plugin.start = function (opts) {
    options = opts || {}

    if (options.discoverOnly) {
      app.debug('Discovery only mode enabled; no injection will occur')
      return
    }

    const discovered = discoverEngines()
    publishDiscovery(discovered)

    ;(options.engines || []).forEach(cfg => {
      const engine = createEngine(cfg)
      engines.push(engine)
      subscribe(engine)
    })
    app.setPluginStatus('Plugin Started - waiting for engines')
  }

  // --------------------
  // Shutdown
  // --------------------
  plugin.stop = function () {
    engines.forEach(stopInjection)
    unsubscribes.forEach(fn => fn())
    engines = []
    unsubscribes = []
  }

  // --------------------
  // Engine object
  // --------------------
  function createEngine(config) {
    const engine = {
      config,
      lastValue: null,
      lastKnown: {},
      timeout: null,
      interval: null,
      isInjecting: false,
      rpmAlive: false
    }

    // restore persisted value
    const restored = app.getSelfPath(config.path)
    if (typeof restored === 'number') {
      engine.lastValue = restored
      app.debug(
        `[${plugin.id}] Restored runtime from model for ${config.path}: ${restored}`
      )
    }

    return engine
  }

  // --------------------
  // Subscriptions
  // --------------------
  function subscribe(engine) {
    // Runtime subscription
    const unsubRuntime = app.streambundle
      .getSelfStream(engine.config.path)
      .onValue(value => handleRuntime(engine, value));

    unsubscribes.push(() => unsubRuntime.unsubscribe?.() || unsubRuntime.end?.(true));

    // Track last-known values for optional keepalive fields
    (options.keepaliveFields || []).forEach(field => {
      let path;

      switch (field) {
        case 'revolutions':
          path = engine.config.path.replace(/runtime|runHours$/i, 'revolutions');
          break;
        case 'oilPressure':
          path = engine.config.path.replace(/runtime|runHours$/i, 'oilPressure');
          break;
        case 'oilTemperature':
          path = engine.config.path.replace(/runtime|runHours$/i, 'oilTemperature');
          break;
        case 'temperature':
          path = engine.config.path.replace(/runtime|runHours$/i, 'temperature');
          break;
        case 'fuelRate':
          path = engine.config.path.replace(/runtime|runHours$/i, 'fuel.rate');
          break;
        default:
          return;
      }

      const unsub = app.streambundle
        .getSelfStream(path)
        .onValue(val => {
          if (!['revolutions', 'oilPressure', 'fuelRate'].includes(field)) {
            engine.lastKnown[field] = val;
          }
        });

      unsubscribes.push(() => unsub.unsubscribe?.() || unsub.end?.(true));
    });
  }

  // --------------------
  // Runtime handler
  // --------------------
  function handleRuntime(engine, value) {
    if (typeof value !== 'number') return

    engine.lastValue = value
    engine.lastSeen = Date.now()

    app.debug(
      `[${plugin.id}] Runtime received from ${engine.config.path}: ${value}`
    ) 

    if (engine.isInjecting) {
      app.setPluginStatus(`Engine active: ${engine.config.path}`)
      app.debug(
        `[${plugin.id}] Engine resumed transmitting on ${engine.config.path}, stopping keepalive`
      )
    }

    stopInjection(engine)

    engine.timeout = setTimeout(() => {
      app.debug(
        `[${plugin.id}] No runtime seen for ${options.startDelaySeconds}s on ${engine.config.path}`
      )

      app.debug(
        `[${plugin.id}] Engine appears stopped, starting keepalive for ${engine.config.path}`
      )
      startInjection(engine)
    }, options.startDelaySeconds * 1000)
  }

  // --------------------
  // Injection control
  // --------------------
  function startInjection(engine) {
    if (engine.isInjecting || engine.lastValue === null) return

    engine.isInjecting = true
    engine.interval = setInterval(
      () => emitDelta(engine),
      options.transmitIntervalSeconds * 1000
    )

    app.debug(
      `[${plugin.id}] Keepalive started for ${engine.config.path} (interval ${options.transmitIntervalSeconds}s)`
    )
  }

  function stopInjection(engine) {
    if (engine.isInjecting) {
      app.debug(
        `[${plugin.id}] Engine started, keepalive stopped for ${engine.config.path}`
      )
    }
    if (engine.interval) clearInterval(engine.interval)
    if (engine.timeout) clearTimeout(engine.timeout)

    engine.interval = null
    engine.timeout = null
    engine.isInjecting = false
  }

  // --------------------
  // Delta emission
  // --------------------
  function emitDelta(engine) {
    app.debug(
      `[${plugin.id}] Emitting synthetic runtime delta for ${engine.config.path}: ${engine.lastValue}`
    );

    const fakeFields = (options.keepaliveFields || []).reduce((acc, field) => {
      if (['revolutions', 'oilPressure', 'fuelRate'].includes(field)) {
        acc[field] = 0; // forced zero to indicate engine off
      } else if (engine.lastKnown[field] !== undefined) {
        acc[field] = engine.lastKnown[field];
      }
      return acc;
    }, {});

    const values = [
      {
        path: engine.config.path,
        value: engine.lastValue
      },
      ...Object.entries(fakeFields).map(([key, val]) => ({
        path: `propulsion.${engine.config.signalkId}.${key}`,
        value: val
      }))
    ];

    const delta = {
      context: 'vessels.self',
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values
        }
      ]
    };

    app.handleMessage(plugin.id, delta);
  }

  // --------------------
  // Discovery
  // --------------------
  function discoverEngines() {
    const propulsion = app.getSelfPath('propulsion')
    if (!propulsion || typeof propulsion !== 'object') return []

    const results = []

    Object.entries(propulsion).forEach(([key, obj]) => {
      if (!obj || typeof obj !== 'object') return

      Object.entries(obj).forEach(([field, value]) => {
        const fieldLower = field.toLowerCase()
        if (fieldLower === 'runtime' || field === 'runhours') {
          results.push({
            path: `propulsion.${key}.${field}`,
            unit: fieldLower === 'runtime' ? 'seconds' : 'hours'
          })
        }
      })
    })

    results.forEach(e =>
      app.debug(`Discovered runtime path: ${e.path}`)
    )

    return results
  }

  function publishDiscovery(list) {
    if (!list.length) {
      app.setPluginStatus(
        'Auto-discovery ran, but no engine runtime paths were found.\n' +
        'Make sure engines have run and runtime data exists.'
      )
      return
    }

    const text =
      'Discovered engine runtime paths:\n' +
      list.map(e => `• ${e.path} (${e.unit})`).join('\n')

    app.setPluginStatus(text)
  }

  return plugin
}
