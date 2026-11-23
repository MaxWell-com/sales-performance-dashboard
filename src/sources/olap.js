// DATA_SOURCE=olap: OLAP cube (src/olapClient.js) and DWH (src/dwhClient.js).
// This source has no client-side stock — that block is hidden on the "Client agent" tab.
import { buildOlapSnapshot } from '../report/olapSnapshot.js';
import { getCustomerOverview, getCustomerStructure, getCustomerProfile } from '../profiles/customerService.js';

export default {
  name: 'olap',
  buildSnapshot: ({ prev } = {}) => buildOlapSnapshot({ prev }),
  customer: { getCustomerOverview, getCustomerStructure, getCustomerProfile },
  clientStock: async () => ({ available: false, error: 'Остатки у клиента не подключены для источника olap' }),
};
