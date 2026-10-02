# Check catalogue

Security QuickScan runs **64 read-only checks**. Each check maps to one primary ISO/IEC 27001:2022 Annex A control (bold) and optional secondary controls.
The "Default from" column is the lowest customer risk profile at which the check is included by default; the consultant can include or exclude any check per scan.

_This file is generated from `packages/shared/src/catalog` by `npm run docs:checks`._

## Microsoft 365 / Entra ID (18)

| Check | Severity | Domain | ISO 27001:2022 | Default from | Other refs |
| --- | --- | --- | --- | --- | --- |
| MFA enforced for all users | critical | Identity & Access | **A.8.5**, A.5.17 | low | M365 CIS 5.2.2.2; NIS2 Art. 21(2)(j) |
| Legacy authentication blocked | high | Identity & Access | **A.8.5** | low | M365 CIS 5.2.2.3 |
| Phishing-resistant MFA for administrators | high | Privileged Access | **A.8.2**, A.8.5 | low | M365 CIS 5.2.2.1 |
| Between 2 and 4 Global Administrators | high | Privileged Access | **A.8.2**, A.5.18 | low | M365 CIS 1.1.3 |
| Privileged accounts are cloud-only | medium | Privileged Access | **A.8.2** | medium | M365 CIS 1.1.1 |
| Users registered for MFA | high | Identity & Access | **A.8.5**, A.5.17 | low |  |
| User consent to applications restricted | medium | Governance & Hygiene | **A.5.19**, A.5.23 | low | M365 CIS 5.1.5.1 |
| Users cannot register applications | low | Governance & Hygiene | **A.5.15**, A.8.9 | medium | M365 CIS 5.1.2.2 |
| Guest invitations restricted | medium | Identity & Access | **A.5.15**, A.5.19 | low | M365 CIS 5.1.6.2 |
| Guest directory access restricted | low | Identity & Access | **A.8.3** | medium | M365 CIS 5.1.6.3 |
| No stale enabled accounts (90+ days) | medium | Identity & Access | **A.5.18**, A.5.16 | low |  |
| No over-privileged application permissions | high | Privileged Access | **A.8.2**, A.5.19 | low |  |
| Privileged Identity Management in use | medium | Privileged Access | **A.8.2** | medium |  |
| Sign-in and user risk policies | medium | Identity & Access | **A.8.16**, A.8.5 | high |  |
| Access requires managed or compliant devices | medium | Identity & Access | **A.8.1**, A.6.7 | high |  |
| Weak MFA methods (SMS / voice) disabled | low | Identity & Access | **A.8.5** | medium |  |
| SPF and DMARC enforced on mail domains | medium | Data Protection | **A.5.14**, A.8.21 | low | M365 CIS 2.1.10 |
| Microsoft Secure Score | low | Governance & Hygiene | **A.8.9**, A.8.8 | low |  |

## Microsoft Azure (9)

| Check | Severity | Domain | ISO 27001:2022 | Default from | Other refs |
| --- | --- | --- | --- | --- | --- |
| Microsoft Defender for Cloud plans enabled | high | Logging & Detection | **A.8.16**, A.8.7, A.8.8 | low | Azure CIS 3.1 |
| Security contact configured | low | Governance & Hygiene | **A.5.24**, A.5.25 | low | Azure CIS 3.1.13 |
| Activity log exported | medium | Logging & Detection | **A.8.15**, A.5.28 | low | Azure CIS 5.1.1 |
| Storage accounts disallow public blob access | high | Data Protection | **A.8.3**, A.8.12 | low | Azure CIS 4.7 |
| Storage enforces HTTPS and TLS 1.2+ | medium | Data Protection | **A.8.24** | low | Azure CIS 4.1 |
| Key Vault purge protection enabled | medium | Data Protection | **A.8.24**, A.8.13 | medium | Azure CIS 8.5 |
| No management ports open to the internet | high | Network Exposure | **A.8.20**, A.8.22 | low | Azure CIS 6.1 |
| SQL servers not open to all IPs | high | Network Exposure | **A.8.20**, A.8.3 | low | Azure CIS 6.3 |
| Limited subscription Owners | medium | Privileged Access | **A.8.2**, A.5.18 | low | Azure CIS 1.23 |

## Amazon Web Services (21)

| Check | Severity | Domain | ISO 27001:2022 | Default from | Other refs |
| --- | --- | --- | --- | --- | --- |
| Root account protected with MFA | critical | Privileged Access | **A.8.5**, A.8.2 | low | AWS CIS 1.5; NIS2 Art. 21(2)(j) |
| No access keys for the root account | critical | Privileged Access | **A.8.2**, A.5.17 | low | AWS CIS 1.4 |
| Console IAM users have MFA | high | Identity & Access | **A.8.5**, A.5.17 | low | AWS CIS 1.10; NIS2 Art. 21(2)(j) |
| Access keys rotated within 90 days | medium | Identity & Access | **A.5.17** | low | AWS CIS 1.14 |
| No unused credentials (90+ days) | medium | Identity & Access | **A.5.18**, A.5.16 | low | AWS CIS 1.12 |
| Strong IAM password policy | low | Identity & Access | **A.5.17** | medium | AWS CIS 1.8 |
| No IAM users with direct AdministratorAccess | high | Privileged Access | **A.8.2**, A.5.15 | low | AWS CIS 1.16 |
| Multi-region CloudTrail with log validation | high | Logging & Detection | **A.8.15**, A.5.28 | low | AWS CIS 3.1; NIS2 Art. 21(2)(b) |
| GuardDuty threat detection enabled | high | Logging & Detection | **A.8.16**, A.5.7 | low | NIS2 Art. 21(2)(b) |
| Security Hub enabled | medium | Governance & Hygiene | **A.8.16**, A.8.9 | medium |  |
| AWS Config recording enabled | medium | Governance & Hygiene | **A.8.9**, A.5.9, A.8.32 | medium | AWS CIS 3.3 |
| Account-level S3 Block Public Access | high | Data Protection | **A.8.3**, A.8.12 | low | AWS CIS 2.1.4 |
| No publicly accessible S3 buckets | critical | Data Protection | **A.8.3**, A.8.12, A.5.34 | low |  |
| EBS encryption by default | medium | Data Protection | **A.8.24** | medium | AWS CIS 2.2.1 |
| No admin ports open to the internet | high | Network Exposure | **A.8.20**, A.8.22 | low | AWS CIS 5.2; NIS2 Art. 21(2)(e) |
| EC2 instances require IMDSv2 | medium | Network Exposure | **A.8.9** | medium | AWS CIS 5.6 |
| No publicly accessible RDS instances | high | Network Exposure | **A.8.20**, A.8.3 | low |  |
| RDS storage encrypted | medium | Data Protection | **A.8.24** | medium | AWS CIS 2.3.1 |
| RDS automated backups retained 7+ days | medium | Data Protection | **A.8.13** | medium | NIS2 Art. 21(2)(c) |
| Customer managed KMS keys rotated | low | Data Protection | **A.8.24** | high | AWS CIS 3.6 |
| IAM Access Analyzer enabled | low | Governance & Hygiene | **A.5.18**, A.5.19 | medium | AWS CIS 1.20 |

## GitHub (16)

| Check | Severity | Domain | ISO 27001:2022 | Default from | Other refs |
| --- | --- | --- | --- | --- | --- |
| Organisation requires 2FA | critical | Identity & Access | **A.8.5**, A.8.4 | low | NIS2 Art. 21(2)(j) |
| Least-privilege base permissions | high | Identity & Access | **A.8.4**, A.5.15 | low |  |
| Limited organisation owners | medium | Privileged Access | **A.8.2** | low |  |
| Outside collaborators reviewed | low | Identity & Access | **A.5.19**, A.5.18 | medium |  |
| Members cannot create public repositories | medium | Data Protection | **A.8.12**, A.8.4 | low |  |
| Private repository forking restricted | low | Data Protection | **A.8.12** | medium |  |
| Public repositories reviewed | info | Data Protection | **A.5.9**, A.8.12 | low |  |
| Default branches protected | high | Code & Supply Chain | **A.8.32**, A.8.25, A.8.4 | low |  |
| Secret scanning enabled | high | Code & Supply Chain | **A.8.28**, A.5.17 | low |  |
| Secret push protection enabled | medium | Code & Supply Chain | **A.8.28**, A.5.17 | medium |  |
| No open critical/high Dependabot alerts | high | Code & Supply Chain | **A.8.8**, A.8.25 | low | NIS2 Art. 21(2)(e) |
| No open critical/high code scanning alerts | medium | Code & Supply Chain | **A.8.28**, A.8.8 | medium |  |
| GitHub Actions restricted to trusted actions | medium | Code & Supply Chain | **A.5.19**, A.8.25 | low |  |
| Read-only default workflow token | high | Code & Supply Chain | **A.8.25**, A.8.2 | low |  |
| Deploy keys are read-only | low | Code & Supply Chain | **A.5.17**, A.8.4 | medium |  |
| Webhooks use verified HTTPS | low | Network Exposure | **A.8.21**, A.8.24 | medium |  |

## Annex A coverage

| Control | Title | Primary checks | Secondary checks |
| --- | --- | --- | --- |
| A.5.7 | Threat intelligence | 0 | 1 |
| A.5.9 | Inventory of information and other associated assets | 1 | 1 |
| A.5.14 | Information transfer | 1 | 0 |
| A.5.15 | Access control | 2 | 2 |
| A.5.16 | Identity management | 0 | 2 |
| A.5.17 | Authentication information | 3 | 6 |
| A.5.18 | Access rights | 3 | 3 |
| A.5.19 | Information security in supplier relationships | 3 | 3 |
| A.5.23 | Information security for use of cloud services | 0 | 1 |
| A.5.24 | Incident management planning and preparation | 1 | 0 |
| A.5.25 | Assessment and decision on information security events | 0 | 1 |
| A.5.28 | Collection of evidence | 0 | 2 |
| A.5.34 | Privacy and protection of PII | 0 | 1 |
| A.6.7 | Remote working | 0 | 1 |
| A.8.1 | User endpoint devices | 1 | 0 |
| A.8.2 | Privileged access rights | 9 | 2 |
| A.8.3 | Information access restriction | 4 | 2 |
| A.8.4 | Access to source code | 1 | 4 |
| A.8.5 | Secure authentication | 7 | 2 |
| A.8.7 | Protection against malware | 0 | 1 |
| A.8.8 | Management of technical vulnerabilities | 1 | 3 |
| A.8.9 | Configuration management | 3 | 2 |
| A.8.12 | Data leakage prevention | 2 | 4 |
| A.8.13 | Information backup | 1 | 1 |
| A.8.15 | Logging | 2 | 0 |
| A.8.16 | Monitoring activities | 4 | 0 |
| A.8.20 | Networks security | 4 | 0 |
| A.8.21 | Security of network services | 1 | 1 |
| A.8.22 | Segregation of networks | 0 | 2 |
| A.8.24 | Use of cryptography | 5 | 1 |
| A.8.25 | Secure development life cycle | 1 | 3 |
| A.8.28 | Secure coding | 3 | 0 |
| A.8.32 | Change management | 1 | 1 |
