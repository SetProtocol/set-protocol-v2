import { SetToken } from "../../contracts/protocol/SetToken.sol";

contract SetTokenTest {
    SetToken setToken;

    function setUp() {
        setToken = new SetToken();
    }
}