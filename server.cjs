const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(process.cwd(), 'dist');
const PORT = 3000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  console.log(`Request: ${req.url}`);
  
  let filePath = path.join(DIST_DIR, req.url === '/' ? 'index.html' : req.url);
  
  if (!fs.existsSync(filePath)) {
    filePath = path.join(DIST_DIR, 'index.html');
  }
  
  const ext = path.extname(filePath);
  const contentType = mimeTypes[ext] || 'application/octet-stream';
  
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    console.log(`Serving: ${filePath}`);
  } catch (e) {
    res.writeHead(500);
    res.end('Error');
  }
});

server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Inser Salud App`);
  console.log(`========================================`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`========================================`);
});