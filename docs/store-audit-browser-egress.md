# Store Audit browser egress boundary

The Store Audit browser worker is limited to an anonymous, read-only storefront
probe: it may add one item to cart and reveal the checkout route, but never
enters buyer data, invokes payment, or submits an order.

All browser HTTPS traffic is sent through a worker-local CONNECT proxy. The
proxy rejects non-HTTPS CONNECT requests, non-443 ports, IP literals,
localhost, private/link-local DNS answers, and mixed public/private DNS
answers. It resolves the approved hostname once and connects its socket to that
specific public IP, while Chromium's TLS handshake passes through the tunnel.
Consequently a DNS rebinding answer cannot change the connection destination
after validation. QUIC is disabled so it cannot bypass the HTTP CONNECT proxy.

The existing URL and request-route checks remain defense in depth. The worker
returns structured capability evidence only; it never retains page text, URLs,
cookies, customer data, or payment data.
