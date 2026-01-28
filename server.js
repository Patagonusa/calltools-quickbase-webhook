require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration
const PORT = process.env.PORT || 3000;
const CALLTOOLS_API_KEY = process.env.CALLTOOLS_API_KEY;
const QUICKBASE_USER_TOKEN = process.env.QUICKBASE_USER_TOKEN;
const QUICKBASE_APP_TOKEN = process.env.QUICKBASE_APP_TOKEN;
const QUICKBASE_REALM = process.env.QUICKBASE_REALM || 'iammanagementsolution.quickbase.com';
const QUICKBASE_TABLE_ID = process.env.QUICKBASE_TABLE_ID || 'bsc9dxrdu';

// Target disposition that triggers QuickBase push
const TARGET_DISPOSITION = 'Cita Spanish';

// State abbreviation to full name mapping
const STATE_NAMES = {
  'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
  'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
  'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
  'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas',
  'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
  'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
  'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
  'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
  'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
  'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
  'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah',
  'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
  'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia'
};

// Convert state abbreviation to full name
function getFullStateName(state) {
  if (!state) return '';
  const upper = state.trim().toUpperCase();
  // If already a full name, return as-is
  if (upper.length > 2) return state;
  return STATE_NAMES[upper] || state;
}

// Format phone number (remove non-digits, ensure 10 digits)
function formatPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  }
  return phone;
}

// Format ZIP code (ensure 5 digits)
function formatZip(zip) {
  if (!zip) return '';
  const digits = String(zip).replace(/\D/g, '');
  return digits.slice(0, 5).padStart(5, '0');
}

// Format date to MM-DD-YYYY for QuickBase
function formatDate(dateStr) {
  if (!dateStr) return '';
  // Try to parse various date formats
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    // If can't parse, return as-is
    return dateStr;
  }
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}-${day}-${year}`;
}

// Extract field from CallTools payload (handles various field naming conventions)
function extractField(data, ...fieldNames) {
  for (const name of fieldNames) {
    // Check direct field
    if (data[name] !== undefined && data[name] !== null && data[name] !== '') {
      return data[name];
    }
    // Check nested in lead object
    if (data.lead && data.lead[name] !== undefined && data.lead[name] !== null && data.lead[name] !== '') {
      return data.lead[name];
    }
    // Check nested in contact object
    if (data.contact && data.contact[name] !== undefined && data.contact[name] !== null && data.contact[name] !== '') {
      return data.contact[name];
    }
    // Check case-insensitive
    const lowerName = name.toLowerCase();
    for (const key of Object.keys(data)) {
      if (key.toLowerCase() === lowerName && data[key] !== undefined && data[key] !== null && data[key] !== '') {
        return data[key];
      }
    }
  }
  return '';
}

// Build comprehensive notes from CallTools data
function buildNotes(data) {
  const parts = [];

  // Get the timestamp
  const now = new Date();
  const timestamp = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  parts.push(`[CallTools - ${timestamp}]`);

  // Disposition
  const disposition = extractField(data, 'disposition', 'Disposition', 'call_disposition', 'CallDisposition');
  if (disposition) parts.push(`Disposition: ${disposition}`);

  // Agent info
  const agent = extractField(data, 'agent', 'Agent', 'agent_name', 'agentName', 'user', 'User', 'rep', 'representative');
  if (agent) parts.push(`Agent: ${agent}`);

  // Call duration
  const duration = extractField(data, 'call_duration', 'callDuration', 'duration', 'Duration', 'talk_time', 'talkTime');
  if (duration) parts.push(`Duration: ${duration}`);

  // Campaign
  const campaign = extractField(data, 'campaign', 'Campaign', 'campaign_name', 'campaignName');
  if (campaign) parts.push(`Campaign: ${campaign}`);

  // List/Lead list
  const list = extractField(data, 'list', 'List', 'list_name', 'listName', 'lead_list', 'leadList');
  if (list) parts.push(`List: ${list}`);

  // Original notes from CallTools
  const originalNotes = extractField(data, 'notes', 'Notes', 'comments', 'Comments', 'note', 'call_notes', 'callNotes');
  if (originalNotes) parts.push(`Notes: ${originalNotes}`);

  return parts.join('\n');
}

// Map CallTools data to QuickBase fields
function mapToQuickBase(calltoolsData) {
  const data = calltoolsData;

  return {
    "92": { value: extractField(data, 'first_name', 'firstName', 'fname', 'FirstName') },
    "93": { value: extractField(data, 'last_name', 'lastName', 'lname', 'LastName') },
    "159": { value: extractField(data, 'spouse_name', 'spouseName', 'spouse', 'SpouseName') },
    "95": { value: extractField(data, 'address', 'street', 'address1', 'street_address', 'Address', 'StreetAddress') },
    "97": { value: extractField(data, 'city', 'City') },
    "98": { value: getFullStateName(extractField(data, 'state', 'State', 'st')) },
    "99": { value: formatZip(extractField(data, 'zip', 'zipcode', 'zip_code', 'postal_code', 'Zip', 'ZipCode')) },
    "108": { value: formatPhone(extractField(data, 'home_phone', 'homePhone', 'home', 'HomePhone')) },
    "109": { value: formatPhone(extractField(data, 'cell_phone', 'cellPhone', 'cell', 'mobile', 'phone', 'Phone', 'CellPhone', 'MobilePhone')) },
    "110": { value: formatPhone(extractField(data, 'alt_phone', 'altPhone', 'alternate_phone', 'work_phone', 'AltPhone')) },
    "111": { value: extractField(data, 'email', 'email_address', 'Email', 'EmailAddress') },
    "160": { value: extractField(data, 'branch', 'Branch', 'office') },
    "11": { value: formatDate(extractField(data, 'appointment_date', 'appointmentDate', 'appt_date', 'AppointmentDate')) },
    "126": { value: extractField(data, 'appointment_time', 'appointmentTime', 'appt_time', 'AppointmentTime') },
    "184": { value: extractField(data, 'campaign_id', 'campaignId', 'campaign', 'CampaignId', 'Campaign') },
    "15": { value: extractField(data, 'product', 'Product', 'service', 'Service') },
    "7": { value: buildNotes(data) },
    "54": { value: extractField(data, 'lead_source', 'leadSource', 'source', 'LeadSource') },
    "177": { value: extractField(data, 'lead_source_subcategory', 'leadSourceSubcategory', 'subcategory', 'LeadSourceSubcategory') }
  };
}

// Create record in QuickBase
async function createQuickBaseRecord(fields) {
  const url = `https://api.quickbase.com/v1/records`;

  // Filter out empty fields
  const filteredFields = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.value !== undefined && val.value !== null && val.value !== '') {
      filteredFields[key] = val;
    }
  }

  const payload = {
    to: QUICKBASE_TABLE_ID,
    data: [filteredFields]
  };

  console.log('QuickBase payload:', JSON.stringify(payload, null, 2));

  const response = await axios.post(url, payload, {
    headers: {
      'QB-Realm-Hostname': QUICKBASE_REALM,
      'Authorization': `QB-USER-TOKEN ${QUICKBASE_USER_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'CallTools to QuickBase Webhook',
    disposition_trigger: TARGET_DISPOSITION
  });
});

// Health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Main webhook endpoint for CallTools
app.post('/webhook/calltools', async (req, res) => {
  console.log('=== Received CallTools Webhook ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));

  try {
    const data = req.body;

    // Extract disposition (check various field names)
    const disposition = extractField(data, 'disposition', 'Disposition', 'call_disposition', 'CallDisposition', 'status', 'Status');

    console.log(`Disposition received: "${disposition}"`);

    // Check if this is the target disposition
    if (disposition.toLowerCase() !== TARGET_DISPOSITION.toLowerCase()) {
      console.log(`Skipping - disposition "${disposition}" does not match target "${TARGET_DISPOSITION}"`);
      return res.json({
        success: true,
        action: 'skipped',
        reason: `Disposition "${disposition}" does not match target "${TARGET_DISPOSITION}"`
      });
    }

    console.log('Disposition matches! Creating QuickBase record...');

    // Map fields and create record
    const qbFields = mapToQuickBase(data);
    const result = await createQuickBaseRecord(qbFields);

    console.log('QuickBase response:', JSON.stringify(result, null, 2));

    res.json({
      success: true,
      action: 'created',
      quickbase_response: result
    });

  } catch (error) {
    console.error('Error processing webhook:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// Test endpoint to manually trigger a QuickBase record creation
app.post('/test/create-record', async (req, res) => {
  console.log('=== Test Record Creation ===');

  try {
    const testData = req.body || {
      first_name: 'Test',
      last_name: 'User',
      phone: '5551234567',
      address: '123 Test St',
      city: 'Los Angeles',
      state: 'CA',
      zip: '90001',
      disposition: 'Cita Spanish'
    };

    const qbFields = mapToQuickBase(testData);
    const result = await createQuickBaseRecord(qbFields);

    res.json({
      success: true,
      quickbase_response: result
    });

  } catch (error) {
    console.error('Test error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// Log incoming webhook payload (for debugging field names)
app.post('/webhook/debug', (req, res) => {
  console.log('=== Debug Webhook ===');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  res.json({ received: true, body: req.body });
});

app.listen(PORT, () => {
  console.log(`CallTools-QuickBase webhook server running on port ${PORT}`);
  console.log(`Target disposition: "${TARGET_DISPOSITION}"`);
  console.log(`QuickBase realm: ${QUICKBASE_REALM}`);
  console.log(`QuickBase table: ${QUICKBASE_TABLE_ID}`);
});
