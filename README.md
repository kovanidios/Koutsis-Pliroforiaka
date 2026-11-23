# Gather Athens

Gather helps a group choose an Athens venue and a time that works for everyone. It includes real restaurants, cinemas, and bars, shareable eight-character room codes, shared venue votes, and a rolling seven-day availability grid in Athens time.

Creating a group opens a waiting room with its code and copyable invite link. Friends join there; when at least one friend has joined, the creator can start the app for the whole group.

## Run locally

```sh
npm start
```

Open [http://localhost:8000](http://localhost:8000), create a room, and share its invite link or code from the waiting room. Run the tests with `npm test`.

## Hosting

Deploy this as a single Node.js process on a host reachable by your friends, with HTTPS enabled, and set `PORT` if the host requires a specific port. Rooms are held in server memory, so they are temporary and are cleared if the process restarts. A persistent database would be needed for durable rooms or a horizontally scaled deployment.

The venue photos are illustrative. Venue names, neighborhoods, and addresses are supplied to help find the real Athens locations; confirm current opening hours and listings with each venue.
