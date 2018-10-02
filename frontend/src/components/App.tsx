import * as React from "react";
import Header from "./Header";
import Home from "./Home";
import PrivateRoute from "./PrivateRoute";
import { ReportPage } from "./Report";
import Router from "./Router";
import Footer from "./Footer";
import Onboarding from "./Onboarding";
import * as actions from "../actions";
import store from "../store";
import { Route } from "react-router-dom";
import "./App.css";

class App extends React.Component<{}, {}> {
  state = {};

  componentDidMount() {
    store.dispatch(actions.initializeAuth());
  }

  render() {
    return (
      <div>
        <Router>
          <div>
            <div className="dark-section">
              <Header />
            </div>
            <div className="light-section">
              <Route exact path="/" component={Home} />
              <PrivateRoute path="/report/:name" component={ReportPage} />
              <PrivateRoute path="/setup" component={Onboarding} />
            </div>
          </div>
        </Router>
        <div className="dark-section darker">
          <Footer />
        </div>
      </div>
    );
  }
}

export default App;