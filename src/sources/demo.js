// DATA_SOURCE=demo: synthetic data (src/demo), no external systems.
import { buildDemoSnapshot } from '../demo/snapshot.js';
import { getCustomerOverview, getCustomerStructure, getCustomerProfile } from '../demo/customerService.js';
import { getClientStock } from '../demo/clientStock.js';

export default {
  name: 'demo',
  buildSnapshot: () => buildDemoSnapshot(),
  customer: { getCustomerOverview, getCustomerStructure, getCustomerProfile },
  clientStock: getClientStock,
};
