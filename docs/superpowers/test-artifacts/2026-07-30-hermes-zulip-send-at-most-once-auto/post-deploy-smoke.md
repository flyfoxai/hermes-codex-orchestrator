# HCO Post-deploy Smoke Report

- Status: PASS
- Mode: DRY_RUN
- Generated at: 1785381240480

## Checks

- PASS `MANIFEST_COMMITTED`: deployment manifest is committed
- PASS `MANIFEST_MODE`: deployment manifest mode is 0600
- PASS `STABLE_SYMLINK`: stable plugin path is a symlink
- PASS `STABLE_TARGET`: stable symlink targets the committed release
- PASS `STABLE_MANIFEST`: stable symlink target matches deployment manifest
- PASS `RELEASE_MANIFEST`: release content matches deployment manifest
- PASS `SOURCE_RELEASE_MATCH`: source and release manifests match
- PASS `ATTESTATION_MATCH`: live attestation matches deployment manifest
- PASS `GATEWAY_PID`: attested gateway PID is alive
- PASS `SERVICE_COMMIT`: deployment committed all service states as running; only gateway PID is checked live
- PASS `ROUTE_SEMANTIC`: live route generation and semantic hash match deployment manifest
- PASS `ROUTE_INTEGRITY`: route snapshot integrity and freshness are valid
