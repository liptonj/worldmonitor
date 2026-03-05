> **Archived**: The SRH Docker container (`srh`) was removed as part of the relay direct fetch migration (Phase 6). This document is kept for historical reference only.

---

docker stop srh; docker rm srh

docker run -d --name srh --restart always -p 8079:80 -e SRH_MODE=env -e SRH_TOKEN=45c1916866dc4b7370457aa0402be7c91e987a6bc11431575ff1917afcb4b2ec -e SRH_CONNECTION_STRING=redis://172.17.0.1:6379 hiett/serverless-redis-http:latest

docker logs srh

curl -X POST https://redis.5ls.us -H "Authorization: Bearer 45c1916866dc4b7370457aa0402be7c91e987a6bc11431575ff1917afcb4b2ec" -d '["PING"]'