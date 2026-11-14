import { Store } from './store.js';
import { createServer } from './server.js';

const port = Number(process.env.PORT) || 3000;

const server = createServer(new Store());
server.listen(port, () => {
  console.log(`Cache node listening on port ${port}`);
});