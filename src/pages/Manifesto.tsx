import { Divider, Panel } from "@/components/term/ui";
import { fmtInt } from "@/lib/format";
import {
  BOOTSTRAP_BLOCKS,
  BOOTSTRAP_MULTIPLIER,
  COIN,
  EMISSION_DECAY_RATE,
  GENESIS_MESSAGE,
  HASHES_AT_DIFFICULTY_1,
  INITIAL_SUBSIDY,
  MAX_TXS_PER_BLOCK,
  RETARGET_INTERVAL,
  SOFT_CAP_SUPPLY,
  TARGET_BLOCK_TIME,
} from "@contracts/protocol";

function Section({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-term glow-soft text-2xl text-neutral-100">
        {n}. {title}
      </h2>
      <div className="space-y-2 text-[13px] leading-relaxed text-neutral-300">{children}</div>
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p>{children}</p>;
}

export default function Manifesto() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-6">
      <header className="border border-neutral-700 px-4 py-6 text-center">
        <p className="text-[10px] uppercase tracking-[0.4em] text-neutral-500">
          The BitWeb Manifesto - Protocol v2 - bitweb-mainnet-1
        </p>
        <h1 className="font-term glow mt-3 text-3xl leading-tight sm:text-4xl">
          YOU ARE NOT YOUR BALANCE
        </h1>
        <p className="mt-3 text-xs text-neutral-400">
          by <span className="text-neutral-200">Tyler Durden</span> - Block Zero - 04 August 2026
        </p>
        <p className="mt-1 text-[11px] text-neutral-600">
          written into the chain, not onto a podium
        </p>
      </header>

      <Panel
        title="READ THIS FIRST - THE LEGAL PANEL"
        bodyClassName="space-y-2 text-[12px] leading-relaxed text-neutral-400"
      >
        <P>
          BitWeb is an <em>experimental, open-source software project</em> published under the MIT
          license by pseudonymous authors. It is a technology demonstration of a peer-to-peer
          protocol - <em>not an investment, not a financial product, and not financial advice</em>.
        </P>
        <P>
          This deployment is the <em>main network</em> (<em>bitweb-mainnet-1</em>). Coins exist
          only because the machinery runs in the open; they have no issuer, no promised value,
          and no guarantee that anyone will ever want them.
        </P>
        <P>
          Nothing on this page or in this document is a financial promotion, an invitation, or an
          inducement to buy, sell, or exchange anything. BTWB coins are produced by running code;
          they have no issuer, no promised value, no redemption, and no utility beyond the
          experiment itself. <em>Expect them to be worth exactly zero.</em> There is no
          "we", there is no team working to increase their price, and nobody owes you anything.
        </P>
        <P>
          If you mine or receive coins, the tax and reporting rules of wherever you live may
          apply to you. Finding out - and complying - is your responsibility alone, wherever you
          are. If you are looking for profit, close this tab. If you are looking for a protocol
          you can read, run, and verify - welcome.
        </P>
      </Panel>

      <Section n="1" title="The First Rule">
        <P>
          The first rule of BitWeb: you do not ask permission. The second rule of BitWeb: you do
          not ask permission. The third rule: if the tab stays open, the chain lives. The fourth
          rule: verify, because everyone else is verifying you. The fifth rule: one browser, one
          vote. The sixth rule: there is no seventh rule - the rules that matter fit in one file,
          and you can read it tonight.
        </P>
        <P>
          For a hundred years the mint was a building with guards. Then it was a warehouse full of
          machines. BitWeb makes it a page on the open web - the most democratic machine humanity
          ever shipped. Not because we are romantics. Because a billion browsers are harder to buy
          than a hundred warehouses.
        </P>
      </Section>

      <Section n="2" title="Our Great Depression Is Our Lives">
        <P>
          We grew up watching money happen somewhere else - decided in rooms we would never enter,
          by institutions we never elected, for reasons explained to us in advertisements. An
          entire generation refreshing balance screens it did not control, holding accounts that
          could be frozen by someone else's risk department, paying tolls to intermediaries for
          the privilege of moving numbers from one column to another.
        </P>
        <P>
          In 2009 a pseudonym showed the exit: money as mathematics, consensus instead of
          permission. Seventeen years later the exit had a gift shop - the hash power condensed
          into silos, the dream got a custodian, and the revolution learned to issue press
          releases. This is not a complaint. It is a reminder that the blueprint still works, and
          that nobody was ever coming to hand it back to us. So we rebuilt it - smaller, stricter,
          and living where it was always meant to live: in the browser, in front of you.
        </P>
      </Section>

      <Section n="3" title="The Opportunity - Anyone with a Connection">
        <P>
          Here is the entire barrier to entry: <em>internet access and an open tab.</em> A phone on
          a night bus. A laptop in a dorm room. A library computer anywhere on earth. No hardware
          to buy, no capital to front, no account to open, no one to email a passport photo to. The
          chain does not know your name, your country, your credit score, or your story - and it
          never will, because the protocol has no field for them.
        </P>
        <P>
          Understand exactly what the opportunity is. It is the opportunity to{" "}
          <em>participate</em> - to run the same software, under the same rules, with the same
          vote as everyone else on earth. A block mined from a dorm-room phone is byte-for-byte
          indistinguishable from one mined in a datacenter, and the chain pays both the same
          subsidy. This is not a promise of wealth and we will never make one. It is a promise of
          a seat at the table - and the table does not check tickets.
        </P>
      </Section>

      <Section n="4" title="The Machine - Rules You Can Read Tonight">
        <P>
          Blocks arrive every {TARGET_BLOCK_TIME} seconds. Each header commits to the previous
          hash, a merkle root, a timestamp, and a nonce; the proof is a double-SHA-256 below an
          adaptive target - honest work, no shortcuts, executed by web workers between two repaints
          of this page. Difficulty retargets every {RETARGET_INTERVAL} blocks - minutes, not
          weeks - clamped so no swing can run away. Difficulty 1 is {fmtInt(HASHES_AT_DIFFICULTY_1)}{" "}
          expected hashes: calibrated so that one ordinary browser still finds blocks alone, the
          way one CPU once could.
        </P>
        <P>
          The subsidy starts at {INITIAL_SUBSIDY / COIN} BTWB per block - multiplied by{" "}
          {BOOTSTRAP_MULTIPLIER} for the first {fmtInt(BOOTSTRAP_BLOCKS)} blocks, so a young
          network has enough coin in circulation to be exercised - and then decays smoothly along
          an exponential curve ({EMISSION_DECAY_RATE} per block), easing toward a soft reference
          of {fmtInt(SOFT_CAP_SUPPLY / COIN)} BTWB with no cliffs and no calendar events. Every
          block pays 70% to its miner, divides 20% equally among the peers who kept that miner
          connected - proven by peer-signed attestations that every node verifies - and burns the
          remaining 10% forever - and every transaction fee is burned in
          full, so usage itself tightens supply. {MAX_TXS_PER_BLOCK} transactions per block. One
          canonical serialization, one curve, one hash function. No premine. No founders'
          allocation. The genesis block's coinbase is cryptographically unspendable - the chain
          begins by giving its first coins to no one. The entire monetary policy lives in{" "}
          <code className="text-neutral-100">contracts/protocol.ts</code>, shared byte-for-byte
          between the node and your browser. Disagree with a number? Fork it. The network only
          speaks proof.
        </P>
      </Section>

      <Section n="5" title="No One Is Coming to Save You">
        <P>
          Your wallet is a secp256k1 keypair generated inside your browser. The private key never
          leaves your machine - not over the wire, not into a cookie, not into an analytics
          beacon. There is no password reset, no support line, no chargeback, no manager. Lose the
          key and the coins are gone the way heat leaves a house in winter: silently and forever.
        </P>
        <P>
          This is not a flaw we forgot to patch. Custody is the whole product of the old world -
          they hold, you ask. Here, you hold. Freedom and responsibility are the same coin, and
          this system mints nothing else. Back up your keys. Write them on paper. Test the backup.
          Then, and only then, play.
        </P>
      </Section>

      <Section n="6" title="Untraceable by Architecture">
        <P>
          Surveillance is usually a feature someone chose. We chose the opposite, line by line.
          There are no accounts, no emails, no names - an address is an anonymous number, and you
          can mint a fresh one for every payment. This site sets no cookies, loads no analytics,
          and makes no third-party requests: even the fonts are self-hosted, because a font fetch
          is an IP leak wearing a costume.
        </P>
        <P>
          There is no server to store anything: this network has no database, no logs, no
          operator. Your node keeps its chain copy inside your own browser, and the only outside
          contact it ever makes is the rendezvous that introduces browsers to one another - after
          the introduction, blocks flow browser-to-browser over encrypted channels. A direct
          connection inherently reveals whatever a direct connection reveals; the protocol itself
          records nothing, anywhere. If you want more than the architecture gives you, run your
          traffic through Tor or a VPN you trust - the protocol won't notice or care.
        </P>
      </Section>

      <Section n="7" title="The Network Has No Center">
        <P>
          Every BitWeb node is equal: same hello, same rules, same right to propose. Nodes find
          each other, exchange blocks, and follow the longest chain - and when two honest nodes
          disagree, the disagreement heals itself: the shorter branch is rolled back, its
          transactions return to the mempool, and the longer chain wins. No coordinator, no
          master, no heartbeat server. This page is one node; your machine can be another; the
          protocol does not keep score of who is who.
        </P>
        <P>
          The full source ships with this page as a zip - MIT licensed, every line. Run a node
          from your bedroom and it is as much "the real BitWeb" as this one is. That is the only
          decentralization claim that has ever meant anything: the center can disappear and the
          circle remains.
        </P>
      </Section>

      <Section n="8" title="Conclusion - The Tab That Stayed Open">
        <P>
          Everything you have read is either running right now or it is a lie, and you can tell
          the difference in one evening: the chain is public, the code is on this page, the rules
          fit in one file. We are not asking you to believe. Belief is the product they sold you.
          We are asking you to leave a tab open and watch a machine keep its own promises.
        </P>
        <P>
          The middle children of history deserve a mint without a door. It is a soap made of
          hashes, and everybody can render the fat. Welcome to Block Zero. You are not your
          balance. You are the network.
        </P>
      </Section>

      <Divider label="Block zero" />

      <Panel title="Hidden in the Genesis Block" bodyClassName="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.25em] text-neutral-500">
          embedded in the coinbase of block #0 - unspendable forever, like Satoshi's headline:
        </p>
        <p className="glow-soft border-l-2 border-neutral-400 pl-3 text-sm italic text-neutral-200">
          "{GENESIS_MESSAGE}"
        </p>
        <p className="text-right text-[11px] text-neutral-500">- Chuck Palahniuk, FIGHT CLUB (1996)</p>
      </Panel>

      <p className="glow-soft text-center text-sm text-neutral-300">
        - TYLER DURDEN - BLOCK ZERO - BITWEB-MAINNET-1 - 23 AUGUST 2026
      </p>
      <p className="text-center text-[11px] text-neutral-600">
        WRITE CODE - MINE BLOCKS - TRUST PROOFS - YOU ARE NOT YOUR BALANCE
      </p>
    </div>
  );
}
