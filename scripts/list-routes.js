const app = require('../src/app')();
const routes = [];
const walk = (stack, prefix = '') => {
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => m !== '_all').map((m) => m.toUpperCase());
      routes.push(`${methods.join(',')} ${prefix}${layer.route.path}`);
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix);
    }
  }
};
walk(app.router.stack);
console.log([...new Set(routes)].sort().join('\n'));
process.exit(0);
