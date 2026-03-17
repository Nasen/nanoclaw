# RingCentral API Reference

Credentials are available as environment variables (injected by NanoClaw for personalMode agents):
- `RC_CLIENT_ID` / `RC_CLIENT_SECRET` — your REST API app credentials
- `RC_JWT` — personal JWT for account-owner auth
- `RC_SERVER` — API host (defaults to `https://platform.ringcentral.com`)

---

## Authentication

### Exchange JWT for access_token

```bash
curl -s -X POST "${RC_SERVER:-https://platform.ringcentral.com}/restapi/oauth/token" \
  -u "${RC_CLIENT_ID}:${RC_CLIENT_SECRET}" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${RC_JWT}"
```

Response: `{ "access_token": "...", "expires_in": 3600, ... }`

### Node.js helper

```javascript
const { SDK } = await import('@ringcentral/sdk');
const sdk = new SDK({
  server: process.env.RC_SERVER ?? 'https://platform.ringcentral.com',
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET,
});
const platform = sdk.platform();
await platform.login({ jwt: process.env.RC_JWT });
// Now use platform.get/post/put/delete
```

---

## Team Messaging

Base path: `/team-messaging/v1`

### Posts

```bash
# Send a post to a chat
curl -s -X POST "${RC_SERVER}/team-messaging/v1/chats/{chatId}/posts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from the API"}'

# List posts in a chat
curl -s "${RC_SERVER}/team-messaging/v1/chats/{chatId}/posts?recordCount=50" \
  -H "Authorization: Bearer $TOKEN"
```

### Chats

```bash
# List all chats
curl -s "${RC_SERVER}/team-messaging/v1/chats?recordCount=250" \
  -H "Authorization: Bearer $TOKEN"

# Get a specific chat
curl -s "${RC_SERVER}/team-messaging/v1/chats/{chatId}" \
  -H "Authorization: Bearer $TOKEN"

# Create a team chat
curl -s -X POST "${RC_SERVER}/team-messaging/v1/teams" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"public": false, "name": "My Team", "members": [{"id": "extensionId"}]}'
```

### Persons (Users)

```bash
# Get own profile
curl -s "${RC_SERVER}/team-messaging/v1/persons/~" \
  -H "Authorization: Bearer $TOKEN"

# Look up a user by ID
curl -s "${RC_SERVER}/team-messaging/v1/persons/{personId}" \
  -H "Authorization: Bearer $TOKEN"
```

### Groups / Direct Messages

```bash
# List groups (DMs, teams)
curl -s "${RC_SERVER}/team-messaging/v1/groups" \
  -H "Authorization: Bearer $TOKEN"

# Get members of a chat
curl -s "${RC_SERVER}/team-messaging/v1/chats/{chatId}/members" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Presence

### Read own presence

```bash
curl -s "${RC_SERVER}/restapi/v1.0/account/~/extension/~/presence" \
  -H "Authorization: Bearer $TOKEN"
```

### Update own presence (DND / Available)

```bash
curl -s -X PUT "${RC_SERVER}/restapi/v1.0/account/~/extension/~/presence" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userStatus": "Busy", "dndStatus": "DoNotAcceptAnyCalls"}'
```

Allowed `userStatus`: `Available`, `Busy`, `Away`
Allowed `dndStatus`: `TakeAllCalls`, `DoNotAcceptDepartmentCalls`, `TakeDepartmentCallsOnly`, `DoNotAcceptAnyCalls`, `DoNotDisturb`

### Read another user's presence

```bash
curl -s "${RC_SERVER}/restapi/v1.0/account/~/extension/{extensionId}/presence" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Account & Extensions

### Get own extension info

```bash
curl -s "${RC_SERVER}/restapi/v1.0/account/~/extension/~" \
  -H "Authorization: Bearer $TOKEN"
```

### List all extensions (paginated)

```bash
curl -s "${RC_SERVER}/restapi/v1.0/account/~/extension?page=1&perPage=100" \
  -H "Authorization: Bearer $TOKEN"
```

### Look up extension by email or name

```bash
curl -s "${RC_SERVER}/restapi/v1.0/account/~/extension?email=user@ringcentral.com" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Contacts

### List personal contacts

```bash
curl -s "${RC_SERVER}/restapi/v1.0/account/~/extension/~/address-book/contact" \
  -H "Authorization: Bearer $TOKEN"
```

### Create a contact

```bash
curl -s -X POST "${RC_SERVER}/restapi/v1.0/account/~/extension/~/address-book/contact" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName": "John", "lastName": "Doe", "email": "john@example.com"}'
```

---

## Phone Numbers

### List own phone numbers

```bash
curl -s "${RC_SERVER}/restapi/v1.0/account/~/extension/~/phone-number" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Common Error Codes

| Status | Meaning | Action |
|--------|---------|--------|
| 401 | Unauthorized / token expired | Re-exchange JWT for fresh token |
| 403 | Forbidden | Check app permissions / extension access |
| 404 | Resource not found | Verify IDs |
| 429 | Rate limited | Retry after `Retry-After` header seconds |
| 503 | Service unavailable | Exponential backoff, retry up to 3x |

---

## Node.js Full Example

```javascript
import { SDK } from '@ringcentral/sdk';

const sdk = new SDK({
  server: process.env.RC_SERVER ?? 'https://platform.ringcentral.com',
  clientId: process.env.RC_CLIENT_ID,
  clientSecret: process.env.RC_CLIENT_SECRET,
});

const platform = sdk.platform();
await platform.login({ jwt: process.env.RC_JWT });

// Get own extension
const resp = await platform.get('/restapi/v1.0/account/~/extension/~');
const me = await resp.json();
console.log(me.id, me.name);

// Send a Team Messaging post
const postResp = await platform.post(
  `/team-messaging/v1/chats/${chatId}/posts`,
  { text: 'Hello from the RC API' },
);
const post = await postResp.json();
console.log(post.id);
```
