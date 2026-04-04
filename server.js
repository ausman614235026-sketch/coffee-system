require('dotenv').config();
const express = require('express');
const expressWs = require('express-ws');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
expressWs(app);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// WebSocket clients for realtime KDS
const wsClients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

app.ws('/ws', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

// ─── MENU ───────────────────────────────────────────────

app.get('/api/menu', async (req, res) => {
  let query = supabase.from('menu_items').select('*').order('category');
  if (!req.query.all) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/menu', async (req, res) => {
  const { name, category, price, icon } = req.body;
  const { data, error } = await supabase
    .from('menu_items')
    .insert([{ name, category, price, icon, active: true }])
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/menu/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('menu_items')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/menu/:id', async (req, res) => {
  const { error } = await supabase
    .from('menu_items')
    .update({ active: false })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── ORDERS ─────────────────────────────────────────────

app.get('/api/orders', async (req, res) => {
  const { status, date } = req.query;
  let query = supabase
    .from('orders')
    .select('*, order_items(*, menu_item:menu_items(name, icon))')
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);
  if (date) {
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end   = new Date(date); end.setHours(23, 59, 59, 999);
    query = query.gte('created_at', start.toISOString()).lte('created_at', end.toISOString());
  }

  const { data, error } = await query.limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/orders', async (req, res) => {
  const { items, total, payment_method, note, customer_id, discount_type, discount_value, discount_amount } = req.body;

  // Get next order number
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const { count } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', new Date().toISOString().slice(0, 10));
  const orderNum = `${today}-${String((count || 0) + 1).padStart(3, '0')}`;

  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .insert([{ order_number: orderNum, total, payment_method, note, status: 'pending',
      customer_id: customer_id || null,
      discount_type: discount_type || null,
      discount_value: discount_value || 0,
      discount_amount: discount_amount || 0
    }])
    .select()
    .single();
  if (orderErr) return res.status(500).json({ error: orderErr.message });

  const orderItems = items.map(i => ({
    order_id: order.id,
    menu_item_id: i.id,
    quantity: i.qty,
    unit_price: i.price,
    subtotal: i.price * i.qty,
    note: i.item_note || ''
  }));
  const { error: itemsErr } = await supabase.from('order_items').insert(orderItems);
  if (itemsErr) return res.status(500).json({ error: itemsErr.message });

  // Handle points: deduct redeemed, add earned
  if (customer_id) {
    const { data: cur } = await supabase.from('customers').select('points').eq('id', customer_id).single();
    let pts = cur?.points || 0;
    // Deduct redeemed points
    if (discount_type === 'points' && discount_value > 0) {
      pts = Math.max(0, pts - discount_value);
    }
    // Add earned points (every 10 baht = 1 point, based on final total)
    const earned = Math.floor(total / 10);
    pts += earned;
    await supabase.from('customers').update({ points: pts }).eq('id', customer_id);
  }

  // Notify KDS via WebSocket
  broadcast({ type: 'NEW_ORDER', order: { ...order, items } });

  res.json(order);
});

app.patch('/api/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase
    .from('orders')
    .update({ status, completed_at: status === 'done' ? new Date().toISOString() : null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  broadcast({ type: 'ORDER_STATUS', id: req.params.id, status });
  res.json(data);
});

// ─── REPORTS ────────────────────────────────────────────

app.get('/api/reports/summary', async (req, res) => {
  const { date } = req.query;
  const target = date || new Date().toISOString().slice(0, 10);
  const start = `${target}T00:00:00`;
  const end   = `${target}T23:59:59`;

  const { data: orders } = await supabase
    .from('orders')
    .select('total, payment_method, created_at')
    .gte('created_at', start)
    .lte('created_at', end)
    .eq('status', 'done');

  const total = (orders || []).reduce((s, o) => s + o.total, 0);
  const count = (orders || []).length;

  // Hourly breakdown
  const hourly = Array(24).fill(0);
  (orders || []).forEach(o => {
    const h = new Date(o.created_at).getHours();
    hourly[h] += o.total;
  });

  // Payment method breakdown
  const byMethod = {};
  (orders || []).forEach(o => {
    byMethod[o.payment_method] = (byMethod[o.payment_method] || 0) + o.total;
  });

  res.json({ total, count, avg: count ? Math.round(total / count) : 0, hourly, byMethod });
});

app.get('/api/reports/top-items', async (req, res) => {
  const { days = 7 } = req.query;
  const since = new Date();
  since.setDate(since.getDate() - parseInt(days));

  const { data, error } = await supabase
    .from('order_items')
    .select('quantity, menu_item:menu_items(name, category), order:orders!inner(created_at, status)')
    .gte('order.created_at', since.toISOString())
    .eq('order.status', 'done');

  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  (data || []).forEach(row => {
    const name = row.menu_item?.name;
    if (name) counts[name] = (counts[name] || 0) + row.quantity;
  });

  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, qty]) => ({ name, qty }));

  res.json(sorted);
});



// ─── PROMOTIONS ─────────────────────────────────────────────

app.get('/api/promotions', async (req, res) => {
  let query = supabase.from('promotions').select('*').order('created_at');
  if (!req.query.all) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/promotions', async (req, res) => {
  const { name, type, value, min_qty } = req.body;
  const { data, error } = await supabase
    .from('promotions')
    .insert([{ name, type, value: parseInt(value), min_qty: parseInt(min_qty)||0, active: true }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/promotions/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('promotions').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/promotions/:id', async (req, res) => {
  const { error } = await supabase.from('promotions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── CUSTOMERS ──────────────────────────────────────────────

app.get('/api/customers', async (req, res) => {
  const { phone } = req.query;
  let query = supabase.from('customers').select('*').order('created_at', { ascending: false });
  if (phone) query = query.ilike('phone', `%${phone}%`);
  const { data, error } = await query.limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/customers', async (req, res) => {
  const { name, phone } = req.body;
  const { data, error } = await supabase
    .from('customers')
    .insert([{ name, phone, points: 0 }])
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/customers/:id/history', async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(quantity, unit_price, menu_item:menu_items(name))')
    .eq('customer_id', req.params.id)
    .eq('status', 'done')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/customers/:id/points', async (req, res) => {
  const { delta } = req.body; // +N or -N
  const { data: cur } = await supabase.from('customers').select('points').eq('id', req.params.id).single();
  const newPoints = Math.max(0, (cur?.points || 0) + delta);
  const { data, error } = await supabase
    .from('customers').update({ points: newPoints }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


// ─── REPORTS EXTENDED ───────────────────────────────────────

// ยอดขายตามช่วงวันที่
app.get('/api/reports/range', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from/to required' });
  const { data: orders, error } = await supabase
    .from('orders')
    .select('total, payment_method, discount_amount, created_at')
    .gte('created_at', `${from}T00:00:00`)
    .lte('created_at', `${to}T23:59:59`)
    .eq('status', 'done');
  if (error) return res.status(500).json({ error: error.message });

  const total = (orders||[]).reduce((s,o) => s + o.total, 0);
  const count = (orders||[]).length;
  const discount = (orders||[]).reduce((s,o) => s + (o.discount_amount||0), 0);
  const byMethod = {};
  (orders||[]).forEach(o => {
    byMethod[o.payment_method] = (byMethod[o.payment_method]||0) + o.total;
  });
  // Daily breakdown
  const daily = {};
  (orders||[]).forEach(o => {
    const d = o.created_at.slice(0,10);
    daily[d] = (daily[d]||0) + o.total;
  });
  res.json({ total, count, avg: count ? Math.round(total/count) : 0, discount, byMethod, daily });
});

// เปรียบเทียบสัปดาห์/เดือน
app.get('/api/reports/compare', async (req, res) => {
  const { mode = 'week' } = req.query; // week or month
  const now = new Date();
  const periods = [];
  for (let i = 0; i < (mode === 'week' ? 4 : 3); i++) {
    let from, to, label;
    if (mode === 'week') {
      to = new Date(now); to.setDate(now.getDate() - i*7);
      from = new Date(to); from.setDate(to.getDate() - 6);
      label = i === 0 ? 'สัปดาห์นี้' : `${i} สัปดาห์ก่อน`;
    } else {
      to = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      from = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const months = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
      label = months[from.getMonth()];
    }
    const { data } = await supabase.from('orders')
      .select('total')
      .gte('created_at', from.toISOString())
      .lte('created_at', to.toISOString())
      .eq('status', 'done');
    const total = (data||[]).reduce((s,o) => s+o.total, 0);
    periods.push({ label, total, count: (data||[]).length });
  }
  res.json(periods.reverse());
});

// ลูกค้าที่ซื้อบ่อยที่สุด
app.get('/api/reports/top-customers', async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('total, customer:customers(id, name, phone, points)')
    .eq('status', 'done')
    .not('customer_id', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  const map = {};
  (data||[]).forEach(o => {
    if (!o.customer) return;
    const id = o.customer.id;
    if (!map[id]) map[id] = { ...o.customer, total: 0, count: 0 };
    map[id].total += o.total;
    map[id].count += 1;
  });
  const sorted = Object.values(map).sort((a,b) => b.total - a.total).slice(0, 10);
  res.json(sorted);
});

// ช่วงเวลาขายดี (peak hours)
app.get('/api/reports/peak-hours', async (req, res) => {
  const { days = 30 } = req.query;
  const since = new Date(); since.setDate(since.getDate() - parseInt(days));
  const { data, error } = await supabase
    .from('orders')
    .select('created_at, total')
    .gte('created_at', since.toISOString())
    .eq('status', 'done');
  if (error) return res.status(500).json({ error: error.message });

  const hours = Array(24).fill(0).map((_,i) => ({ hour: i, total: 0, count: 0 }));
  (data||[]).forEach(o => {
    const h = new Date(o.created_at).getHours();
    hours[h].total += o.total;
    hours[h].count += 1;
  });
  res.json(hours);
});

// ส่วนลดทั้งหมด
app.get('/api/reports/discounts', async (req, res) => {
  const { from, to } = req.query;
  let query = supabase.from('orders')
    .select('discount_type, discount_value, discount_amount, created_at')
    .eq('status', 'done')
    .not('discount_type', 'is', null);
  if (from) query = query.gte('created_at', `${from}T00:00:00`);
  if (to) query = query.lte('created_at', `${to}T23:59:59`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const totalDiscount = (data||[]).reduce((s,o) => s+(o.discount_amount||0), 0);
  const byType = {};
  (data||[]).forEach(o => {
    const t = o.discount_type || 'other';
    if (!byType[t]) byType[t] = { count: 0, total: 0 };
    byType[t].count += 1;
    byType[t].total += o.discount_amount || 0;
  });
  res.json({ totalDiscount, count: (data||[]).length, byType });
});

// ─── HEALTH CHECK ────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Cafe POS API running on port ${PORT}`));
