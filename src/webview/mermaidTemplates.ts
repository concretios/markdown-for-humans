/**
 * Copyright (c) 2025-2026 Concret.io
 *
 * Licensed under the MIT License. See LICENSE file in the project root for details.
 */

/**
 * Mermaid diagram templates for the toolbar dropdown
 * These templates provide starter code for various Mermaid diagram types
 */

import * as l10n from './l10n';

export interface MermaidTemplate {
  label: string;
  diagram: string;
}

export const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    label: l10n.t('Flowchart'),
    diagram: `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Process]
    B -->|No| D[Alternative]
    C --> E[End]
    D --> E`,
  },
  {
    label: l10n.t('Sequence Diagram'),
    diagram: `sequenceDiagram
    participant Client
    participant Server
    participant Database
    Client->>Server: Request data
    Server->>Database: Query
    Database-->>Server: Results
    Server-->>Client: Response`,
  },
  {
    label: l10n.t('Class Diagram'),
    diagram: `classDiagram
    class Animal {
        +String name
        +int age
        +makeSound()
    }
    class Dog {
        +String breed
        +bark()
    }
    Animal <|-- Dog`,
  },
  {
    label: l10n.t('State Diagram'),
    diagram: `stateDiagram-v2
    [*] --> Idle
    Idle --> Processing: Start
    Processing --> Success: Complete
    Processing --> Error: Fail
    Success --> [*]
    Error --> Idle: Retry`,
  },
  {
    label: l10n.t('Entity Relationship Diagram'),
    diagram: `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    CUSTOMER {
        string name
        string email
    }
    ORDER {
        int orderNumber
        date orderDate
    }`,
  },
  {
    label: l10n.t('Gantt Chart'),
    diagram: `gantt
    title Project Schedule
    dateFormat  YYYY-MM-DD
    section Planning
    Research           :a1, 2024-01-01, 7d
    Design             :a2, after a1, 5d
    section Development
    Implementation     :a3, after a2, 10d
    Testing            :a4, after a3, 5d`,
  },
  {
    label: l10n.t('Pie Chart'),
    diagram: `pie title Distribution
    "Category A" : 45
    "Category B" : 30
    "Category C" : 15
    "Category D" : 10`,
  },
  {
    label: l10n.t('User Journey'),
    diagram: `journey
    title User Shopping Experience
    section Browse
      View Products: 5: Customer
      Filter Results: 3: Customer
    section Purchase
      Add to Cart: 4: Customer
      Checkout: 2: Customer`,
  },
  {
    label: l10n.t('Git Graph (Timeline)'),
    diagram: `gitGraph
    commit
    commit
    branch develop
    checkout develop
    commit
    commit
    checkout main
    merge develop
    commit`,
  },
  {
    label: l10n.t('Mindmap'),
    diagram: `mindmap
  root((Project))
    Planning
      Requirements
      Design
    Development
      Frontend
      Backend
    Testing
      Unit Tests
      Integration`,
  },
  {
    label: l10n.t('Requirement Diagram'),
    diagram: `requirementDiagram
    requirement user_req {
        id: 1
        text: User shall be able to login
        risk: high
        verifymethod: test
    }
    element login_system {
        type: system
    }
    user_req - satisfies -> login_system`,
  },
  {
    label: l10n.t('C4 Diagram'),
    diagram: `C4Context
    title System Context diagram for Internet Banking System
    Person(customer, "Customer", "A customer of the bank")
    System(banking, "Internet Banking System", "Allows customers to view information")
    System_Ext(email, "E-mail System", "Sends e-mails")
    Rel(customer, banking, "Uses")
    Rel(banking, email, "Sends e-mails using")`,
  },
  {
    label: l10n.t('Sankey Diagram'),
    diagram: `sankey-beta
    Agricultural 'waste',Bio-conversion,124.729
    Bio-conversion,Liquid,0.597
    Bio-conversion,Losses,26.862
    Bio-conversion,Solid,280.322
    Bio-conversion,Gas,81.144`,
  },
  {
    label: l10n.t('XY Chart'),
    diagram: `xychart-beta
    title "Sales Revenue"
    x-axis [Jan, Feb, Mar, Apr, May]
    y-axis "Revenue (in $)" 0 --> 100
    line [30, 40, 50, 60, 70]
    bar [20, 30, 40, 50, 60]`,
  },
  {
    label: l10n.t('Quadrant Chart'),
    diagram: `quadrantChart
    title Priority Matrix
    x-axis Low Effort --> High Effort
    y-axis Low Impact --> High Impact
    quadrant-1 Quick Wins
    quadrant-2 Major Projects
    quadrant-3 Fill-Ins
    quadrant-4 Hard Slogs
    Feature A: [0.3, 0.8]
    Feature B: [0.7, 0.7]
    Feature C: [0.2, 0.3]`,
  },
];
