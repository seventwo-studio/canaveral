//! Destination decisions and live-flow revalidation; native evidence is supplied separately.
use canaveral_guest_protocol::{
    data::ErrorCode,
    proxy::{target, Target},
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, net::IpAddr};
use uuid::Uuid;
const ALLOCATED: &str = include_str!("../policy/ipv6-allocated.cidrs");
const ALLOCATED_SHA256: &str = "e4d88628225247190ed94324edd90a1cead5c9317b857cedb7ea6b772199bbb3";
const TABLE: &str = include_str!("../policy/public-https-v1.cidrs");
pub const TABLE_SHA256: &str = "2d8b719c77f473e854167deff0eb2d551ff1f7df34d3bb52be8aba88465f6130";
#[derive(Clone, Debug)]
pub struct Cidr {
    address: IpAddr,
    bits: u8,
}
impl Cidr {
    pub fn parse(s: &str) -> Result<Self, ErrorCode> {
        let (address, bits) = s.split_once('/').ok_or(ErrorCode::DestinationDenied)?;
        let address = address
            .parse::<IpAddr>()
            .map_err(|_| ErrorCode::DestinationDenied)?;
        let bits = bits
            .parse::<u8>()
            .map_err(|_| ErrorCode::DestinationDenied)?;
        if bits > if address.is_ipv4() { 32 } else { 128 } {
            return Err(ErrorCode::DestinationDenied);
        }
        let cidr = Self { address, bits };
        // Configuration must describe the actual network, not an address within it.
        let canonical = match address {
            IpAddr::V4(a) => {
                u32::from(a) & u32::MAX.checked_shl((32 - bits) as u32).unwrap_or(0) == u32::from(a)
            }
            IpAddr::V6(a) => {
                u128::from(a) & u128::MAX.checked_shl((128 - bits) as u32).unwrap_or(0)
                    == u128::from(a)
            }
        };
        if !canonical {
            return Err(ErrorCode::DestinationDenied);
        }
        Ok(cidr)
    }
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.address, ip) {
            (IpAddr::V4(a), IpAddr::V4(b)) => {
                ((u32::from(a) ^ u32::from(b)) >> (32 - self.bits).min(31)) == 0 || self.bits == 0
            }
            (IpAddr::V6(a), IpAddr::V6(b)) => {
                ((u128::from(a) ^ u128::from(b)) >> (128 - self.bits).min(127)) == 0
                    || self.bits == 0
            }
            _ => false,
        }
    }
}
/// Complete fresh evidence is mandatory at connect and after connecting.
/// A route provider must identify the actual route, including cached/cloned routes.
pub struct Evidence {
    pub interfaces: Vec<IpAddr>,
    pub prefix: u8,
    pub gateway: bool,
    pub direct: bool,
}
pub trait HostEvidence {
    fn evidence(&mut self, address: IpAddr) -> Result<Evidence, ErrorCode>;
}
pub struct Policy {
    denied: Vec<Cidr>,
    allocated: Vec<Cidr>,
    operator: Vec<Cidr>,
}
impl Policy {
    pub fn new(operator: &[String]) -> Result<Self, ErrorCode> {
        if format!("{:x}", Sha256::digest(TABLE.as_bytes())) != TABLE_SHA256
            || format!("{:x}", Sha256::digest(ALLOCATED.as_bytes())) != ALLOCATED_SHA256
        {
            return Err(ErrorCode::DestinationDenied);
        }
        if operator.len() > 4096 {
            return Err(ErrorCode::Limit);
        }
        Ok(Self {
            allocated: ALLOCATED
                .lines()
                .map(Cidr::parse)
                .collect::<Result<_, _>>()?,
            denied: TABLE.lines().map(Cidr::parse).collect::<Result<_, _>>()?,
            operator: operator
                .iter()
                .map(|s| Cidr::parse(s))
                .collect::<Result<_, _>>()?,
        })
    }
    pub fn address(&self, address: IpAddr, evidence: &Evidence) -> Result<(), ErrorCode> {
        // Deny reserved holes as well as space outside allocated global unicast.
        if evidence.interfaces.is_empty() {
            return Err(ErrorCode::RouteDenied);
        }
        if matches!(address, IpAddr::V6(_)) && !self.allocated.iter().any(|c| c.contains(address))
            || self
                .denied
                .iter()
                .chain(&self.operator)
                .any(|c| c.contains(address))
            || evidence.interfaces.contains(&address)
        {
            return Err(ErrorCode::DestinationDenied);
        }
        if evidence.prefix != 0 || !evidence.gateway || evidence.direct {
            return Err(ErrorCode::RouteDenied);
        }
        Ok(())
    }
    /// Vet every terminal answer before returning any connect candidate.
    pub fn answers(
        &self,
        name: &str,
        port: u16,
        enabled: bool,
        authorized: bool,
        answers: &[IpAddr],
        host: &mut impl HostEvidence,
    ) -> Result<Vec<IpAddr>, ErrorCode> {
        let parsed = target(name)?;
        if port != 443 {
            return Err(ErrorCode::PortDenied);
        }
        if !enabled || !authorized {
            return Err(ErrorCode::EgressDenied);
        }
        if answers.is_empty() || answers.len() > 64 {
            return Err(ErrorCode::DestinationDenied);
        }
        if let Target::Address(ip) = parsed {
            if answers != [ip] {
                return Err(ErrorCode::DestinationDenied);
            }
        }
        for address in answers {
            self.address(
                *address,
                &host
                    .evidence(*address)
                    .map_err(|_| ErrorCode::RouteDenied)?,
            )?;
        }
        Ok(answers.to_vec())
    }
    pub fn recheck(&self, address: IpAddr, host: &mut impl HostEvidence) -> Result<(), ErrorCode> {
        self.address(
            address,
            &host.evidence(address).map_err(|_| ErrorCode::RouteDenied)?,
        )
    }
}
/// Called from the data reactor at least every two seconds. Returned IDs must be
/// closed before another payload turn; any evidence failure closes the affected flow.
#[derive(Default)]
pub struct Live {
    flows: BTreeMap<Uuid, IpAddr>,
    next: u64,
}
impl Live {
    pub fn pin(&mut self, id: Uuid, address: IpAddr) -> Result<(), ErrorCode> {
        if self.flows.len() >= 16 || self.flows.contains_key(&id) {
            return Err(ErrorCode::Limit);
        }
        self.flows.insert(id, address);
        Ok(())
    }
    pub fn remove(&mut self, id: Uuid) {
        self.flows.remove(&id);
    }
    pub fn revalidate(
        &mut self,
        now_ms: u64,
        policy: &Policy,
        host: &mut impl HostEvidence,
    ) -> Vec<(Uuid, ErrorCode)> {
        if now_ms < self.next {
            return Vec::new();
        }
        self.next = now_ms.saturating_add(2000);
        let invalid: Vec<_> = self
            .flows
            .iter()
            .filter_map(|(id, address)| {
                policy
                    .recheck(*address, host)
                    .err()
                    .map(|_| (*id, ErrorCode::RouteDenied))
            })
            .collect();
        for (id, _) in &invalid {
            self.flows.remove(id);
        }
        invalid
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }
    struct Host {
        addresses: Vec<IpAddr>,
        prefix: u8,
        fail: bool,
    }
    impl HostEvidence for Host {
        fn evidence(&mut self, _: IpAddr) -> Result<Evidence, ErrorCode> {
            if self.fail {
                return Err(ErrorCode::RouteDenied);
            }
            Ok(Evidence {
                interfaces: self.addresses.clone(),
                prefix: self.prefix,
                gateway: true,
                direct: false,
            })
        }
    }
    #[test]
    fn every_table_entry_and_nested_global_exceptions_are_denied() {
        let p = Policy::new(&[]).unwrap();
        let e = Evidence {
            interfaces: vec![ip("127.0.0.1")],
            prefix: 0,
            gateway: true,
            direct: false,
        };
        for line in TABLE.lines() {
            let c = Cidr::parse(line).unwrap();
            assert!(p.address(c.address, &e).is_err(), "{line}");
        }
        for s in [
            "192.0.0.9",
            "192.0.0.10",
            "2001:1::3",
            "::ffff:808:808",
            "64:ff9b::808:808",
            "2002:808:808::1",
            "fd7a:115c:a1e0::1",
            "fe80::1",
            "ff02::1",
            "4000::1",
            "2004::1",
            "3ffe::1",
            "2621::1",
        ] {
            assert!(p.address(ip(s), &e).is_err(), "{s}");
        }
        for s in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            p.address(ip(s), &e).unwrap();
        }
        for c in ["1.2.3.4/24", "::1/64", "1.1.1.1/33", "::/129"] {
            assert!(Cidr::parse(c).is_err());
        }
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(ip("8.8.8.8")));
        assert!(!Cidr::parse("8.8.8.8/32").unwrap().contains(ip("8.8.8.9")));
    }
    #[test]
    fn mixed_answers_interfaces_operator_route_and_revalidation() {
        let p = Policy::new(&["9.0.0.0/8".into()]).unwrap();
        let mut h = Host {
            addresses: vec![ip("127.0.0.1")],
            prefix: 0,
            fail: false,
        };
        let check =
            |h: &mut Host, ips: &[IpAddr]| p.answers("example.com.", 443, true, true, ips, h);
        assert!(check(&mut h, &[ip("8.8.8.8")]).is_ok());
        assert!(check(&mut h, &[ip("8.8.8.8"), ip("127.0.0.1")]).is_err());
        assert!(check(&mut h, &[ip("9.1.1.1")]).is_err());
        h.addresses.push(ip("8.8.8.8"));
        assert!(check(&mut h, &[ip("8.8.8.8")]).is_err());
        h.addresses = vec![ip("127.0.0.1")];
        h.fail = true;
        assert!(check(&mut h, &[ip("8.8.8.8")]).is_err());
        h.fail = false;
        let mut live = Live::default();
        let id = Uuid::from_u128(1);
        live.pin(id, ip("8.8.8.8")).unwrap();
        assert!(live.revalidate(0, &p, &mut h).is_empty());
        h.prefix = 32;
        assert!(live.revalidate(1999, &p, &mut h).is_empty());
        assert_eq!(
            live.revalidate(2000, &p, &mut h),
            vec![(id, ErrorCode::RouteDenied)]
        );
        assert!(live.flows.is_empty());
    }
}
