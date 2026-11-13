import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { River3Accessory } from './accessory.js';
import { River3Device } from './ecoflow/device.js';
import { SimulatorTransport } from './ecoflow/simulator.js';
import { CloudTransport, type Transport } from './ecoflow/transport.js';
import {
  DEFAULT_API_HOST,
  KNOWN_SERIAL_PREFIXES,
  PLATFORM_NAME,
  PLUGIN_NAME,
  readDeviceConfig,
  type DeviceConfig,
} from './settings.js';

export class River3Platform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly devices: River3Device[] = [];
  /** The accessories this platform is currently serving, by serial number. */
  readonly accessories = new Map<string, River3Accessory>();
  private transport?: Transport;

  constructor(
    readonly log: Logging,
    private readonly config: PlatformConfig,
    readonly api: API,
  ) {
    api.on('didFinishLaunching', () => this.launch());
    api.on('shutdown', () => this.shutdown());
  }

  /** Homebridge hands back accessories it remembered from the last run. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private launch(): void {
    const deviceConfigs = this.readDevices();
    const transport = deviceConfigs.length > 0 ? this.createTransport() : undefined;

    const wanted = new Set<string>();
    if (transport) {
      this.transport = transport;
      for (const deviceConfig of deviceConfigs) {
        const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${deviceConfig.serialNumber}`);
        wanted.add(uuid);
        let accessory = this.cached.get(uuid);
        if (accessory) {
          accessory.displayName = deviceConfig.name;
        } else {
          accessory = new this.api.platformAccessory(deviceConfig.name, uuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.log.info(`Added ${deviceConfig.name} (${deviceConfig.serialNumber})`);
        }
        const device = new River3Device(deviceConfig.serialNumber, transport, this.log);
        this.devices.push(device);
        this.accessories.set(deviceConfig.serialNumber, new River3Accessory(this, accessory, device, deviceConfig));
        device.start();
      }
      transport.start();
    }

    const stale = [...this.cached.values()].filter((accessory) => !wanted.has(accessory.UUID));
    if (stale.length > 0 && (transport || deviceConfigs.length === 0)) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const accessory of stale) {
        this.log.info(`Removed ${accessory.displayName}, which is no longer in the plugin settings`);
      }
    }
  }

  private readDevices(): DeviceConfig[] {
    const list = Array.isArray(this.config.devices) ? (this.config.devices as unknown[]) : [];
    const seen = new Set<string>();
    const devices: DeviceConfig[] = [];
    for (const raw of list) {
      const deviceConfig = readDeviceConfig(raw);
      if (!deviceConfig) {
        this.log.warn('Skipping a device with no serial number in the plugin settings');
        continue;
      }
      if (seen.has(deviceConfig.serialNumber)) {
        this.log.warn(`Skipping a second entry for ${deviceConfig.serialNumber}`);
        continue;
      }
      seen.add(deviceConfig.serialNumber);
      if (!(deviceConfig.serialNumber.slice(0, 4) in KNOWN_SERIAL_PREFIXES)) {
        this.log.warn(
          `${deviceConfig.serialNumber} does not look like a RIVER 3 or RIVER 3 Plus serial number. Trying it anyway.`,
        );
      }
      devices.push(deviceConfig);
    }
    if (devices.length === 0) {
      this.log.warn('No devices are set up. Add your RIVER 3 serial number in the plugin settings.');
    }
    return devices;
  }

  private createTransport(): Transport | undefined {
    if (this.config.simulate === true) {
      this.log.warn('Simulation is on: showing a pretend RIVER 3, not your real one.');
      return new SimulatorTransport();
    }
    const email = typeof this.config.email === 'string' ? this.config.email.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';
    if (!email || !password) {
      this.log.error('Add your EcoFlow app email and password in the plugin settings, then restart Homebridge.');
      return undefined;
    }
    const apiHost =
      typeof this.config.apiHost === 'string' && this.config.apiHost.trim() ? this.config.apiHost.trim() : DEFAULT_API_HOST;
    return new CloudTransport({ email, password, apiHost }, this.log);
  }

  private shutdown(): void {
    for (const device of this.devices) {
      device.stop();
    }
    this.transport?.stop();
  }
}
