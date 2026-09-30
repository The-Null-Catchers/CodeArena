import Playground from "../../../components/Playground";
export default function Page() {
  return (
    <>
      <div className="page-title">
        <div>
          <h1>Playground</h1>
          <p>Write, run, and inspect. Every execution has its own boundary.</p>
        </div>
        <span className="pill">ISOLATED EXECUTION</span>
      </div>
      <Playground />
    </>
  );
}
