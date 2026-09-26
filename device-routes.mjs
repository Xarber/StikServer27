// Match all advertised identities, not just the first field: a relay may know
// the UDID while LAN discovery knows the Bonjour identifier for the same device.
export function selectDeviceRoutes(devices) {
  const groups = [];
  const normalize = value => String(value || "").trim().toLowerCase()
    .replace(/^(sidestore-agent|native|nearby|stikserver)\|/, "");
  const cost = device => !device.controllable ? Infinity
    : device.mode === "direct" ? 0 : Number(device.routeHops || 1);
  for (const device of devices) {
    const ids = new Set([device.id, device.serviceIdentifier, device.pairingIdentifier, device.udid]
      .map(normalize).filter(Boolean));
    const matches = groups.filter(group => [...ids].some(id => group.ids.has(id)));
    let best = device;
    for (const group of matches) {
      for (const id of group.ids) ids.add(id);
      if (cost(group.device) <= cost(best)) best = group.device;
      groups.splice(groups.indexOf(group), 1);
    }
    groups.push({ ids, device: best });
  }
  return groups.map(group => group.device);
}
