import { Store } from './store.js';
import { createServer } from './server.js';
import { startSweeper } from './expiry.js';

const port = Number(process.env.PORT) || 3000;

const store = new Store();
startSweeper(store, 1000);

const server = createServer(store);
server.listen(port, () => {
  console.log(`Cache node listening on port ${port}`);
});