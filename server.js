const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve everything in /public statically
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for the root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Data Query Tool running at: http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
